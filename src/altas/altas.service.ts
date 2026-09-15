/**
 * Alta completa de un contribuyente para facturación + e-Ventanilla, en una
 * sola sesión de AFIP:
 *
 *   login → CSR → certificado (computador fiscal) → Vault
 *         → relación WebServices > Facturación Electrónica
 *         → relación WebServices > Consulta y lectura de Comunicaciones (DFE)
 *         → punto de venta → Supabase
 *
 * Es una copia endurecida de `src/scrapper/scrapper.service.ts`, que queda
 * intacto porque es el que está corriendo en producción.
 *
 * Diferencias de fondo:
 *  - Nada de estado en la instancia: cada corrida lleva su `RunContext`. En el
 *    original, `currentAlias` / `currentSalePoint` / `browser` eran campos del
 *    servicio y dos jobs simultáneos se pisaban entre sí.
 *  - El certificado se guarda en Vault APENAS se descarga, antes de seguir con
 *    las relaciones y el punto de venta. Si algo falla después, el cert no se
 *    pierde (en AFIP ya existe igual: perder la clave privada lo deja inútil).
 *  - Los jobs quedan en un sqlite en disco con etapa y código de error.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Browser, Page } from 'puppeteer';
import { X509Certificate } from 'crypto';
import { join } from 'path';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { CertService } from '../cert/cert.service';
import { config } from '../config/config';
import { AltaJobEntity } from './alta-job.entity';
import {
  AltasSupabaseService,
  FacturacionUser,
} from './altas-supabase.service';
import {
  AltaError,
  AltaErrorCode,
  AltaOptions,
  AltaStage,
  DEFAULT_ALTA_OPTIONS,
  RunContext,
  RunResult,
} from './altas.types';
import {
  buscarServicio,
  launchBrowser,
  openArcaAndLogin,
  shot,
  sleep,
} from './afip/portal';
import {
  CSR_FILENAME,
  KEY_FILENAME,
  crearCertificado,
} from './afip/certificados';
import {
  SERVICIO_FE,
  SERVICIO_WSCCOMU,
  adherirRelacion,
} from './afip/relaciones';
import { resolverPuntoVenta } from './afip/punto-venta';

const SERVICIO_CERTIFICADOS = 'Administración de Certificados Digitales';
const SERVICIO_RELACIONES = 'Administrador de Relaciones de Clave Fiscal';
const SERVICIO_PUNTOS_VENTA = 'Administración de Puntos de Venta y Domicilios';

export interface CrearAltaDto {
  /** CUIT del contribuyente. */
  username: string;
  /**
   * Datos para crear la fila de `facturacion_users` si todavía no existe.
   * El orquestador los manda desde `clients` (con la clave desencriptada).
   */
  realName?: string;
  password?: string;
  externalClient?: boolean;
  /** Pasos a correr. Por defecto, todos. */
  opciones?: Partial<AltaOptions>;
}

@Injectable()
export class AltasService {
  private readonly logger = new Logger(AltasService.name);
  /**
   * Cola serial. Una corrida abre un Chromium, loguea en AFIP y tarda 3-4
   * minutos; correr varias en paralelo desde la misma IP es la forma más
   * rápida de que AFIP empiece a pedir captcha.
   */
  private cola: Promise<unknown> = Promise.resolve();
  private enCola = 0;

  constructor(
    @InjectRepository(AltaJobEntity, 'altas')
    private readonly jobs: Repository<AltaJobEntity>,
    private readonly supabase: AltasSupabaseService,
    private readonly cert: CertService,
  ) {}

  // ── API ───────────────────────────────────────────────────────────────────

  async crear(dto: CrearAltaDto): Promise<{ jobId: number; enCola: number }> {
    const cuit = dto.username.replace(/\D/g, '');
    const job = await this.jobs.save(
      this.jobs.create({
        username: cuit,
        realName: dto.realName,
        status: 'pending',
        stage: AltaStage.INICIADO,
      }),
    );

    this.enCola++;
    const posicion = this.enCola;
    this.cola = this.cola
      .then(() => this.correrJob(job.id, cuit, dto))
      .catch((e) => this.logger.error(`Job #${job.id} sin capturar: ${e}`))
      .finally(() => {
        this.enCola--;
      });

    return { jobId: job.id, enCola: posicion };
  }

  async getJob(id: number): Promise<AltaJobEntity> {
    const job = await this.jobs.findOne({ where: { id } });
    if (!job) throw new NotFoundException(`No existe el job ${id}`);
    return job;
  }

  async listJobs(opts: {
    username?: string;
    status?: string;
    limit?: number;
  }): Promise<AltaJobEntity[]> {
    return this.jobs.find({
      where: {
        ...(opts.username
          ? { username: opts.username.replace(/\D/g, '') }
          : {}),
        ...(opts.status ? { status: opts.status } : {}),
      },
      order: { id: 'DESC' },
      take: Math.min(opts.limit ?? 100, 1000),
    });
  }

  // ── Corrida ───────────────────────────────────────────────────────────────

  private async correrJob(
    jobId: number,
    cuit: string,
    dto: CrearAltaDto,
  ): Promise<void> {
    await this.jobs.update(jobId, {
      status: 'running',
      startedAt: new Date(),
    });

    let ctx: RunContext | undefined;
    let browser: Browser | undefined;

    try {
      const user = await this.resolverUsuario(cuit, dto);
      const opts: AltaOptions = { ...DEFAULT_ALTA_OPTIONS, ...dto.opciones };

      const { dirs, alias } = this.prepararDirectorios(cuit);
      await this.jobs.update(jobId, { alias, shotsDir: dirs.shots });

      browser = await launchBrowser(opts.headless ?? config.scrapper.headless);
      const portal = await openArcaAndLogin(
        browser,
        cuit,
        user.password ?? '',
        dirs.shots,
      );

      ctx = {
        cuit,
        realName: user.real_name || dto.realName || '',
        facturacionUserId: String(user.id),
        browser,
        portal,
        alias,
        downloadsDir: dirs.downloads,
        uploadsDir: dirs.uploads,
        shotsDir: dirs.shots,
        stage: AltaStage.LOGIN_OK,
        opts,
        warnings: [],
      };
      await this.persistirEtapa(jobId, ctx);

      const resultado = await this.correrFlujo(ctx, jobId);

      await this.jobs.update(jobId, {
        status: 'success',
        stage: resultado.stage,
        alias: resultado.alias,
        salePoint: resultado.salePoint,
        salePointPreexistente: resultado.salePointPreexistente,
        certEnVault: resultado.certEnVault,
        certReusado: resultado.certReusado,
        relacionFeOk: resultado.relacionFeOk,
        relacionWsccomuOk: resultado.relacionWsccomuOk,
        parcial: resultado.parcial,
        warnings: resultado.warnings.join('\n') || undefined,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Job #${jobId} (${cuit}) OK — pdv ${resultado.salePoint ?? '-'}, ` +
          `cert ${resultado.certEnVault ? 'en Vault' : 'NO'}${resultado.parcial ? ' [PARCIAL]' : ''}`,
      );
    } catch (e) {
      const code =
        e instanceof AltaError ? e.code : this.inferirCodigo(e as Error);
      const mensaje = e instanceof Error ? e.message : String(e);
      const detalle =
        e instanceof AltaError && e.detalle ? ` — ${e.detalle}` : '';

      // Aunque falle, si el certificado llegó a Vault el alta quedó a medias:
      // hay que reportarlo, porque en AFIP quedó un computador fiscal nuevo.
      const parcial = !!ctx?.certEnVault;

      await this.jobs.update(jobId, {
        status: 'error',
        stage: ctx?.stage ?? AltaStage.INICIADO,
        errorCode: code,
        error: `${mensaje}${detalle}`,
        alias: ctx?.alias,
        salePoint: ctx?.salePoint,
        certEnVault: !!ctx?.certEnVault,
        certReusado: !!ctx?.certReusado,
        relacionFeOk: !!ctx?.relacionFeOk,
        relacionWsccomuOk: !!ctx?.relacionWsccomuOk,
        parcial,
        warnings: ctx?.warnings.join('\n') || undefined,
        finishedAt: new Date(),
      });
      this.logger.error(
        `Job #${jobId} (${cuit}) ${code}: ${mensaje}${detalle}` +
          (parcial
            ? ctx?.certReusado
              ? ' [PARCIAL: cert preexistente, alta sin terminar]'
              : ' [PARCIAL: cert creado pero sin empresa]'
            : ''),
      );
      if (ctx) await shot(ctx.portal, ctx.shotsDir, '99-error');
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  /** El flujo propiamente dicho, ya con sesión abierta. */
  private async correrFlujo(
    ctx: RunContext,
    jobId: number,
  ): Promise<RunResult> {
    const avanzar = async (stage: AltaStage): Promise<void> => {
      ctx.stage = stage;
      await this.persistirEtapa(jobId, ctx);
    };

    // 1) Certificado.
    //
    // Siempre se mira Vault primero, incluso cuando `certificado` es false: las
    // relaciones de servicio tienen que autorizar el computador que REALMENTE
    // existe en AFIP, y ese alias es el CN del certificado guardado. Sin esto,
    // un reintento de "sólo punto de venta y relaciones" autorizaba un alias
    // recién inventado que no existe.
    const aliasNuevo = ctx.alias;
    const enVault = await this.leerCertDeVault(ctx);
    const debeCrear =
      ctx.opts.certificado && (!enVault || ctx.opts.reusarCert === false);

    if (debeCrear) {
      ctx.alias = aliasNuevo; // el CN viejo no sirve: se crea uno nuevo
      ctx.certReusado = false;
      this.generarCsr(ctx);
      await avanzar(AltaStage.CSR_GENERADO);

      const pageCert = await buscarServicio(
        ctx.browser,
        ctx.portal,
        SERVICIO_CERTIFICADOS,
        ctx.shotsDir,
        'cert',
      );
      const pem = await crearCertificado(ctx, pageCert);
      await avanzar(AltaStage.CERT_DESCARGADO);
      await this.guardarEnVault(ctx, pem);
      await avanzar(AltaStage.CERT_EN_VAULT);
      await pageCert.close().catch(() => {});
    } else if (enVault) {
      await avanzar(AltaStage.CERT_EN_VAULT);
    } else {
      ctx.warnings.push(
        'No hay certificado en Vault y no se pidió crear uno: las relaciones ' +
          'de servicio no van a encontrar el computador fiscal.',
      );
    }

    // 2) Relaciones de servicio.
    if (ctx.opts.relacionFe) {
      await this.correrRelacion(ctx, SERVICIO_FE, 'fe');
      if (ctx.relacionFeOk) await avanzar(AltaStage.RELACION_FE);
    }
    if (ctx.opts.relacionWsccomu) {
      await this.correrRelacion(ctx, SERVICIO_WSCCOMU, 'wsccomu');
      if (ctx.relacionWsccomuOk) await avanzar(AltaStage.RELACION_WSCCOMU);
    }

    // 3) Punto de venta.
    if (ctx.opts.puntoVenta) {
      const pagePv = await buscarServicio(
        ctx.browser,
        ctx.portal,
        SERVICIO_PUNTOS_VENTA,
        ctx.shotsDir,
        'pv',
      );
      const pv = await resolverPuntoVenta(ctx, pagePv);
      ctx.salePoint = pv.numero;
      ctx.salePointPreexistente = pv.preexistente;
      await pagePv.close().catch(() => {});

      await this.supabase.updateSalePoint(ctx.cuit, pv.numero);
      await avanzar(AltaStage.PUNTO_VENTA);
    } else {
      await this.supabase.touchUpdatedAt(ctx.cuit);
    }

    // 4) Marcar la adhesión de e-Ventanilla en `clients`, para que el script
    //    `adherir-ventanilla.ts` no lo vuelva a procesar.
    if (ctx.relacionWsccomuOk) {
      await this.supabase.marcarVentanillaAdherida(ctx.cuit);
    }

    await avanzar(AltaStage.COMPLETADO);

    const completo =
      (!ctx.opts.certificado || !!ctx.certEnVault) &&
      (!ctx.opts.relacionFe || !!ctx.relacionFeOk) &&
      (!ctx.opts.relacionWsccomu || !!ctx.relacionWsccomuOk) &&
      (!ctx.opts.puntoVenta || !!ctx.salePoint);

    return {
      alias: ctx.alias,
      salePoint: ctx.salePoint,
      salePointPreexistente: !!ctx.salePointPreexistente,
      certEnVault: !!ctx.certEnVault,
      certReusado: !!ctx.certReusado,
      relacionFeOk: !!ctx.relacionFeOk,
      relacionWsccomuOk: !!ctx.relacionWsccomuOk,
      stage: ctx.stage,
      parcial: !!ctx.certEnVault && !completo,
      warnings: ctx.warnings,
    };
  }

  /**
   * Una relación de servicio. No aborta el alta si falla: se anota el warning y
   * se sigue, así el punto de venta igual queda hecho y el reporte muestra
   * exactamente qué faltó.
   */
  private async correrRelacion(
    ctx: RunContext,
    labels: string[],
    tag: 'fe' | 'wsccomu',
  ): Promise<void> {
    let page: Page | undefined;
    try {
      // Un certificado recién creado tarda en aparecer en Administrador de
      // Relaciones. Medido en la corrida del 2026-09-04: le pasó a 3 de 30.
      // Reintentar con espera es mucho más barato que dejar el alta a medias.
      let res: Awaited<ReturnType<typeof adherirRelacion>> | undefined;
      for (
        let intento = 1;
        intento <= config.scrapper.relacionIntentos;
        intento++
      ) {
        page = await buscarServicio(
          ctx.browser,
          ctx.portal,
          SERVICIO_RELACIONES,
          ctx.shotsDir,
          `rel-${tag}-${intento}`,
        );
        res = await adherirRelacion(ctx, page, {
          serviceLabels: labels,
          aliasExacto: ctx.alias,
          etiqueta: intento === 1 ? tag : `${tag}-r${intento}`,
        });
        await page.close().catch(() => {});
        page = undefined;

        if (res.ok || !res.computadorNoPublicado) break;
        if (intento < config.scrapper.relacionIntentos) {
          this.logger.warn(
            `${ctx.cuit} [${tag}] AFIP todavía no publica el computador; ` +
              `reintento ${intento + 1} en ${config.scrapper.relacionEsperaMs / 1000}s`,
          );
          await sleep(config.scrapper.relacionEsperaMs);
        }
      }

      if (res?.ok) {
        if (tag === 'fe') {
          ctx.relacionFeOk = true;
          ctx.stage = AltaStage.RELACION_FE;
        } else {
          ctx.relacionWsccomuOk = true;
          ctx.stage = AltaStage.RELACION_WSCCOMU;
        }
        this.logger.log(`${ctx.cuit} [${tag}] ${res.detalle}`);
      } else if (res) {
        ctx.warnings.push(`[${tag}] ${res.detalle}`);
        this.logger.warn(`${ctx.cuit} [${tag}] ${res.detalle}`);
      }
    } catch (e) {
      // La representación faltante sí es terminal: sin eso no hay nada que hacer.
      if (
        e instanceof AltaError &&
        e.code === AltaErrorCode.REPRESENTACION_REQUERIDA
      ) {
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      ctx.warnings.push(`[${tag}] ${msg}`);
      this.logger.warn(`${ctx.cuit} [${tag}] falló: ${msg}`);
    } finally {
      await page?.close().catch(() => {});
    }
  }

  // ── Piezas ────────────────────────────────────────────────────────────────

  /** Busca (o crea) la fila de facturacion_users. */
  private async resolverUsuario(
    cuit: string,
    dto: CrearAltaDto,
  ): Promise<FacturacionUser> {
    if (dto.realName && dto.password) {
      const { user } = await this.supabase.ensureFacturacionUser(cuit, {
        realName: dto.realName,
        password: dto.password,
        externalClient: dto.externalClient,
      });
      return user;
    }

    const user = await this.supabase.getFacturacionUser(cuit);
    if (!user) {
      throw new AltaError(
        AltaErrorCode.SIN_FACTURACION_USER,
        `No hay fila en facturacion_users para el CUIT ${cuit}`,
        'Mandar realName + password en el body para crearla automáticamente.',
      );
    }
    if (!user.password) {
      throw new AltaError(
        AltaErrorCode.SIN_FACTURACION_USER,
        `El CUIT ${cuit} no tiene clave fiscal cargada en facturacion_users`,
      );
    }
    return user;
  }

  /** Directorios exclusivos de la corrida (nada compartido entre jobs). */
  private prepararDirectorios(cuit: string): {
    dirs: { uploads: string; downloads: string; shots: string };
    alias: string;
  } {
    const stamp = Date.now();
    const base = join(
      config.scrapper.workDir || join(process.cwd(), '.altas'),
      cuit,
      String(stamp),
    );
    const dirs = {
      uploads: join(base, 'uploads'),
      downloads: join(base, 'downloads'),
      shots: join(base, 'shots'),
    };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    // Mismo formato de alias que el scrapper original, para que los scripts
    // que buscan "new-csr" lo sigan encontrando.
    return { dirs, alias: `new-csr-${stamp}` };
  }

  /**
   * Lee el certificado de Vault y, si está vigente, toma su CN como alias.
   *
   * Sirve para dos cosas: evitar crear un CSR de más (cada uno deja un
   * computador fiscal más en AFIP, y es justo lo que después hace elegir el
   * equivocado en Administrador de Relaciones), y saber qué computador
   * autorizar cuando la corrida no crea certificado.
   */
  private async leerCertDeVault(ctx: RunContext): Promise<boolean> {
    try {
      const { cert, key } = await this.cert.getUserCertificateAndKey(
        ctx.facturacionUserId,
      );
      if (!cert || !key) return false;

      const x = new X509Certificate(cert);
      if (new Date(x.validTo).getTime() < Date.now()) {
        this.logger.log(
          `${ctx.cuit}: el cert en Vault está vencido, se rehace`,
        );
        return false;
      }
      // El CN es el alias del computador fiscal: hace falta para autorizar el
      // servicio sobre el computador correcto.
      const cn = /CN=([^\n,]+)/.exec(x.subject)?.[1]?.trim();
      if (!cn) return false;

      ctx.alias = cn;
      ctx.certEnVault = true;
      ctx.certReusado = true;
      this.logger.log(
        `${ctx.cuit}: certificado ya en Vault (CN=${cn}, vence ${x.validTo})`,
      );
      return true;
    } catch {
      // 404 en Vault = todavía no hay certificado. Cualquier otro problema de
      // lectura se trata igual: se intenta crear uno.
      return false;
    }
  }

  /** Genera key + CSR de la corrida y los deja en el uploads propio. */
  private generarCsr(ctx: RunContext): void {
    try {
      const { privateKeyPem } = this.cert.generateKeyPair();
      const serialNumber = config.scrapper.csrSerialFormat.replace(
        '{cuit}',
        ctx.cuit,
      );
      const csrPem = this.cert.generateCsr(privateKeyPem, [
        { name: 'commonName', value: ctx.alias },
        { name: 'organizationName', value: ctx.realName || ctx.cuit },
        { name: 'countryName', value: 'AR' },
        { name: 'serialNumber', value: serialNumber },
      ]);

      writeFileSync(
        join(ctx.uploadsDir, KEY_FILENAME),
        normalizarPem(privateKeyPem),
        {
          encoding: 'utf8',
          mode: 0o600,
        },
      );
      writeFileSync(join(ctx.uploadsDir, CSR_FILENAME), normalizarPem(csrPem), {
        encoding: 'utf8',
      });
      this.logger.log(
        `${ctx.cuit}: CSR generado (CN=${ctx.alias}, serialNumber=${serialNumber})`,
      );
    } catch (e) {
      throw new AltaError(
        AltaErrorCode.CSR_FALLIDO,
        'No se pudo generar el par de claves / CSR',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /** Guarda key + cert en Vault apenas se descarga el certificado. */
  private async guardarEnVault(ctx: RunContext, pem: string): Promise<void> {
    // Red de seguridad decisiva: AFIP emite el certificado a nombre del
    // REPRESENTADO, no del CUIT que pusimos en el CSR. Si por lo que sea la
    // sesión estaba operando en nombre de otro (una sociedad que el cliente
    // representa), el certificado sale con el CUIT de ese otro. Guardarlo en
    // Vault bajo este cliente sería datos corruptos, así que se corta.
    const cuitDelCert = /serialNumber=CUIT\s*(\d+)/.exec(
      new X509Certificate(pem).subject,
    )?.[1];
    if (cuitDelCert && cuitDelCert !== ctx.cuit) {
      throw new AltaError(
        AltaErrorCode.CERT_NO_CREADO,
        `AFIP emitió el certificado a nombre de otro CUIT (${cuitDelCert}), no de ${ctx.cuit}`,
        'La sesión estaba operando en representación de un tercero. ' +
          'El certificado NO se guardó en Vault.',
      );
    }

    const keyPem = normalizarPem(
      readFileSync(join(ctx.uploadsDir, KEY_FILENAME), 'utf-8'),
    );
    try {
      await this.cert.loadUserCertificateAndKey(
        ctx.facturacionUserId,
        keyPem,
        normalizarPem(pem),
      );
      ctx.certEnVault = true;
      ctx.stage = AltaStage.CERT_EN_VAULT;
      this.logger.log(
        `${ctx.cuit}: certificado guardado en Vault (id ${ctx.facturacionUserId})`,
      );
    } catch (e) {
      throw new AltaError(
        AltaErrorCode.VAULT_FALLIDO,
        'El certificado se descargó pero no se pudo guardar en Vault',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /**
   * Deja la etapa en la base a medida que avanza. En una corrida de 12 h el
   * orquestador necesita poder ver en qué anda cada CUIT sin esperar el final.
   */
  private async persistirEtapa(jobId: number, ctx: RunContext): Promise<void> {
    await this.jobs.update(jobId, {
      stage: ctx.stage,
      alias: ctx.alias,
      certEnVault: !!ctx.certEnVault,
      certReusado: !!ctx.certReusado,
      relacionFeOk: !!ctx.relacionFeOk,
      relacionWsccomuOk: !!ctx.relacionWsccomuOk,
      salePoint: ctx.salePoint,
    });
  }

  /** Traduce errores no tipados a un código estable. */
  private inferirCodigo(e: Error): AltaErrorCode {
    const m = (e?.message || '').toLowerCase();
    if (m.includes('timeout') || m.includes('waiting for')) {
      return AltaErrorCode.TIMEOUT;
    }
    if (m.includes('vault')) return AltaErrorCode.VAULT_FALLIDO;
    return AltaErrorCode.DESCONOCIDO;
  }
}

/** AFIP no acepta PEM con CRLF. */
const normalizarPem = (pem: string): string => pem.replace(/\r\n/g, '\n');

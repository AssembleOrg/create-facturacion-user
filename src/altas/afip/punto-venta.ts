/**
 * "Administración de Puntos de Venta y Domicilios": resuelve el punto de venta
 * de Web Services (lo crea si no existe, lo lee si ya está).
 *
 * Acá vivía casi toda la deuda técnica del scrapper original:
 *
 *  1. La empresa se elegía con `tokens.some(t => value.includes(t))`: alcanzaba
 *     que UN token del nombre coincidiera. Con "JUAN CARLOS PARDO" cualquier
 *     botón que dijera "JUAN" ganaba, y el alta terminaba en el contribuyente
 *     equivocado. Ahora se puntúa por cantidad de tokens y se exige que el
 *     ganador sea único; si empata, se corta con EMPRESA_NO_ENCONTRADA.
 *  2. El diálogo de advertencias se esperaba 16 s como obligatorio y hacía
 *     fallar el alta cuando no aparecía. Ahora es opcional.
 *  3. El número del punto de venta nuevo salía de `totalRecords + 1`, que no es
 *     el máximo: si había un PDV 5 dado de baja y 3 activos, intentaba crear el
 *     4 y AFIP lo rechazaba. Ahora se lee la grilla y se usa max + 1, con
 *     reintento si AFIP dice que ya existe.
 *  4. El sistema se seteaba fijo en 'MAW' y el domicilio en '1-1'. Si el combo
 *     no tenía esos valores, `select()` tiraba y el alta moría. Ahora se elige
 *     del combo real, POR CONDICIÓN del contribuyente: en el combo de AFIP las
 *     opciones de Exento en IVA vienen antes que las de Monotributo, así que
 *     "la primera que diga Web Services" le crea a un monotributista un punto
 *     de venta de exento — válido para AFIP e inservible para el cliente.
 *     Verificado en producción el 2026-09-04. Si la condición no se puede
 *     deducir sin ambigüedad, el alta se corta y pide intervención.
 *  5. El "Aceptar" dependía de un único xpath sobre el texto del span. Ahora se
 *     intenta por varias vías y se REVERIFICA que el punto de venta haya
 *     quedado creado.
 */
import { Page } from 'puppeteer';
import { Logger } from '@nestjs/common';
import { config } from '../../config/config';
import { AltaError, AltaErrorCode, RunContext } from '../altas.types';
import { esperarEstable, normalize, shot, sleep } from './portal';

const logger = new Logger('AfipPuntoVenta');

/** Descripciones de sistema que sirven para facturar por web service. */
const ES_WEB_SERVICE = (texto: string): boolean => {
  const t = normalize(texto);
  return t.includes('web service') || t.includes('webservice');
};

/** Condición frente al IVA que declara el nombre de un sistema de AFIP. */
type Condicion = 'monotributo' | 'exento' | 'ri';

/**
 * Deduce la condición a partir del texto de un sistema.
 * El orden importa: "CAEA - Fact. Elect. (RECE) - Exento en IVA" nombra RECE
 * (que es el régimen de los inscriptos) pero es de un exento.
 */
const condicionDe = (texto: string): Condicion | null => {
  const t = normalize(texto);
  if (t.includes('monotributo') || t.includes('monotributista'))
    return 'monotributo';
  if (t.includes('exento')) return 'exento';
  if (t.includes('responsable inscripto') || t.includes('rece')) return 'ri';
  return null;
};

export interface PuntoVentaResult {
  numero: number;
  preexistente: boolean;
  /** Descripción del sistema tal como la muestra AFIP. */
  sistema?: string;
}

interface FilaPdv {
  numero: number;
  descripcion: string;
  baja: boolean;
}

export async function resolverPuntoVenta(
  ctx: RunContext,
  page: Page,
): Promise<PuntoVentaResult> {
  const timeout = config.scrapper.timeoutMs;
  page.setDefaultTimeout(timeout);

  await elegirEmpresa(ctx, page);

  // Entrar al ABM de puntos de venta. El click navega.
  await page.waitForSelector('#btn_abm_pto_vta', { timeout });
  await Promise.all([
    page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 })
      .catch(() => null),
    page.click('#btn_abm_pto_vta'),
  ]);
  await esperarEstable(page);

  // El diálogo de advertencias es OPCIONAL: si no está, se sigue.
  await cerrarAdvertencias(page);
  await shot(page, ctx.shotsDir, 'pv-01-grilla');

  const filas = await leerGrilla(page);
  logger.log(
    `${ctx.cuit}: ${filas.length} puntos de venta en la grilla → ${filas
      .map((f) => `${f.numero}:${f.descripcion}${f.baja ? '(baja)' : ''}`)
      .join(', ')}`,
  );

  const existente = filas.find((f) => !f.baja && ES_WEB_SERVICE(f.descripcion));
  if (existente) {
    logger.log(
      `${ctx.cuit}: ya tenía punto de venta ${existente.numero} (${existente.descripcion})`,
    );
    return {
      numero: existente.numero,
      preexistente: true,
      sistema: existente.descripcion,
    };
  }

  // Condición del contribuyente según los puntos de venta que YA tiene. Es la
  // única evidencia directa que da AFIP en esta pantalla, y es la que decide
  // qué sistema de facturación corresponde.
  const condicion = condicionDesdeGrilla(filas);
  logger.log(
    `${ctx.cuit}: condición inferida de la grilla → ${condicion ?? '(indeterminada)'}`,
  );

  // No hay: hay que crearlo. Se prueban hasta 3 números por si AFIP rechaza.
  const usados = new Set(filas.map((f) => f.numero));
  let candidato = (filas.length ? Math.max(...usados) : 0) + 1;
  let ultimoError = '';

  for (let intento = 0; intento < 3; intento++) {
    while (usados.has(candidato)) candidato++;
    try {
      const sistema = await altaPuntoVenta(ctx, page, candidato, condicion);
      const verificado = await verificarAlta(page, candidato, sistema);
      if (!verificado) {
        ultimoError = `El alta del punto de venta ${candidato} no se reflejó en la grilla`;
        usados.add(candidato);
        candidato++;
        continue;
      }
      logger.log(
        `${ctx.cuit}: punto de venta ${candidato} creado (${sistema})`,
      );
      return { numero: candidato, preexistente: false, sistema };
    } catch (e) {
      if (
        e instanceof AltaError &&
        e.code !== AltaErrorCode.PUNTO_VENTA_FALLIDO
      )
        throw e;
      ultimoError = e instanceof Error ? e.message : String(e);
      logger.warn(
        `${ctx.cuit}: falló el alta del punto de venta ${candidato}: ${ultimoError}`,
      );
      usados.add(candidato);
      candidato++;
      await volverAGrilla(page);
    }
  }

  await shot(page, ctx.shotsDir, 'pv-99-fallido');
  throw new AltaError(
    AltaErrorCode.PUNTO_VENTA_FALLIDO,
    'No se pudo crear el punto de venta',
    ultimoError,
  );
}

// ── Selección de la empresa/contribuyente ───────────────────────────────────

/**
 * La primera pantalla del servicio lista los contribuyentes que el CUIT puede
 * administrar, como botones. Se elige el que más tokens del nombre comparte,
 * exigiendo que el ganador sea único.
 */
async function elegirEmpresa(ctx: RunContext, page: Page): Promise<void> {
  const sel = 'td[align="center"] input[type="button"]';
  try {
    await page.waitForSelector(sel, { timeout: 15_000 });
  } catch {
    // Algunos CUIT entran directo al ABM, sin pantalla de selección.
    if (await page.$('#btn_abm_pto_vta')) return;
    await shot(page, ctx.shotsDir, 'pv-00-sin-empresas');
    throw new AltaError(
      AltaErrorCode.EMPRESA_NO_ENCONTRADA,
      'No apareció la lista de contribuyentes ni el ABM de puntos de venta',
    );
  }

  const elegido = await page.evaluate(
    ({ selector, nombre, cuit }) => {
      const norm = (s: string) =>
        (s || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^A-Za-z0-9 ]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toUpperCase();

      const tokens = norm(nombre)
        .split(' ')
        // Partículas y tokens muy cortos no aportan y generan falsos positivos.
        .filter(
          (t) =>
            t.length >= 3 && !['DEL', 'LOS', 'LAS', 'SRL', 'SA'].includes(t),
        );

      const botones = Array.from(
        document.querySelectorAll<HTMLInputElement>(selector),
      );

      const puntuados = botones.map((b, i) => {
        const val = norm(b.value);
        const valTokens = new Set(val.split(' '));
        const score = tokens.filter((t) => valTokens.has(t)).length;
        // El CUIT en el botón es evidencia dura: gana sobre cualquier nombre.
        const tieneCuit = b.value.replace(/\D/g, '').includes(cuit);
        return { i, val: b.value, score: tieneCuit ? 99 : score };
      });

      const ordenados = [...puntuados].sort((a, b) => b.score - a.score);
      const mejor = ordenados[0];
      const segundo = ordenados[1];

      if (!mejor || mejor.score === 0) {
        return { ok: false, motivo: 'sin-coincidencia', opciones: puntuados };
      }
      // Un solo token en común es demasiado débil salvo que el nombre entero
      // sea de un token.
      if (mejor.score < Math.min(2, tokens.length)) {
        return { ok: false, motivo: 'coincidencia-debil', opciones: puntuados };
      }
      if (segundo && segundo.score === mejor.score) {
        return { ok: false, motivo: 'ambiguo', opciones: puntuados };
      }

      botones[mejor.i].click();
      return { ok: true, elegido: mejor.val, opciones: puntuados };
    },
    { selector: sel, nombre: ctx.realName, cuit: ctx.cuit },
  );

  if (!elegido.ok) {
    await shot(page, ctx.shotsDir, 'pv-00-empresa-ambigua');
    const detalle = (elegido.opciones || [])
      .map((o) => `${o.val} (score ${o.score})`)
      .join(' | ');
    throw new AltaError(
      AltaErrorCode.EMPRESA_NO_ENCONTRADA,
      `No se pudo identificar sin ambigüedad al contribuyente "${ctx.realName}" (${elegido.motivo})`,
      detalle,
    );
  }

  logger.log(`${ctx.cuit}: contribuyente elegido → ${elegido.elegido}`);
  // El botón del contribuyente dispara un postback.
  await page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 })
    .catch(() => null);
  await esperarEstable(page);
}

/** El diálogo de advertencias aparece a veces; nunca puede ser bloqueante. */
async function cerrarAdvertencias(page: Page): Promise<void> {
  const btn = await page
    .waitForSelector('#dlgAdvertencias_btn_Cerrar', {
      timeout: 6_000,
      visible: true,
    })
    .catch(() => null);
  if (!btn) return;
  await btn.click().catch(() => {});
  await btn.dispose();
  await sleep(1_500);
}

// ── Grilla ──────────────────────────────────────────────────────────────────

/** Lee los puntos de venta de la grilla: número, descripción y si está de baja. */
async function leerGrilla(page: Page): Promise<FilaPdv[]> {
  await page
    .waitForSelector('#tblmiGrilla_dataTable', { timeout: 15_000 })
    .catch(() => null);

  return page.evaluate(() => {
    const norm = (s: string | null | undefined) =>
      (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    const tabla = document.querySelector('#tblmiGrilla_dataTable');
    if (!tabla) return [];
    const filas: { numero: number; descripcion: string; baja: boolean }[] = [];
    for (const row of Array.from(tabla.querySelectorAll('tr'))) {
      const celdas = Array.from(row.querySelectorAll('td')).map((td) =>
        norm(td.textContent),
      );
      if (celdas.length < 2) continue;
      const numero = parseInt(celdas[0].replace(/\D/g, ''), 10);
      if (!Number.isFinite(numero)) continue;
      const resto = celdas.slice(1).join(' | ');
      filas.push({
        numero,
        descripcion: resto,
        baja: /baja|dado de baja/i.test(resto),
      });
    }
    return filas;
  });
}

/** Después de un alta fallida, volver a la grilla para reintentar. */
async function volverAGrilla(page: Page): Promise<void> {
  const cerrar = await page.$('#frmAlta_btnCancelar, input[value="Cancelar"]');
  if (cerrar) {
    await cerrar.click().catch(() => {});
    await cerrar.dispose();
  }
  await sleep(2_000);
}

// ── Alta ────────────────────────────────────────────────────────────────────

/** Completa y acepta el formulario de alta. Devuelve el sistema elegido. */
async function altaPuntoVenta(
  ctx: RunContext,
  page: Page,
  numero: number,
  condicion: Condicion | null,
): Promise<string> {
  const timeout = config.scrapper.timeoutMs;

  if (!(await clickAgregar(page))) {
    throw new AltaError(
      AltaErrorCode.PUNTO_VENTA_FALLIDO,
      'No se encontró el botón "Agregar.."',
    );
  }
  await sleep(3_000);
  await shot(page, ctx.shotsDir, `pv-02-form-${numero}`);

  await page.waitForSelector('#frmAlta_pveNro', { timeout });
  await page.evaluate(() => {
    const el = document.querySelector('#frmAlta_pveNro') as HTMLInputElement;
    if (el) el.value = '';
  });
  await page.type('#frmAlta_pveNro', String(numero), { delay: 30 });

  const sistema = await elegirSistema(ctx, page, condicion);

  await elegirOpcion(
    page,
    '#frmAlta_codTipoDomicilio',
    (opts) =>
      opts.find((o) => o.value === '1-1') ??
      opts.find((o) => normalize(o.texto).includes('fiscal')) ??
      opts.find((o) => o.value !== ''),
    'tipo de domicilio',
  );

  await shot(page, ctx.shotsDir, `pv-03-form-completo-${numero}`);

  if (!(await clickAceptar(page))) {
    await shot(page, ctx.shotsDir, `pv-03-sin-aceptar-${numero}`);
    throw new AltaError(
      AltaErrorCode.PUNTO_VENTA_FALLIDO,
      'No se encontró el botón "Aceptar" del formulario de alta',
    );
  }
  await sleep(4_000);

  // Confirmación ("¿Confirma el alta?") y avisos posteriores.
  await confirmarDialogos(page);
  await shot(page, ctx.shotsDir, `pv-04-post-alta-${numero}`);

  const error = await leerErrorFormulario(page);
  if (error) {
    throw new AltaError(
      AltaErrorCode.PUNTO_VENTA_FALLIDO,
      `AFIP rechazó el alta del punto de venta ${numero}`,
      error,
    );
  }

  return sistema;
}

/** Click en "Agregar..", tolerando las variantes del portal. */
async function clickAgregar(page: Page): Promise<boolean> {
  const [btn] = await page.$$(
    'xpath/ .//span[@class="ui-button-text" and contains(normalize-space(text()),"Agregar")]',
  );
  if (btn) {
    await btn.click();
    await btn.dispose();
    return true;
  }
  return clickPorTexto(page, ['agregar..', 'agregar', 'nuevo', 'alta']);
}

/**
 * Click en "Aceptar". El original dependía de un único xpath sobre el span;
 * acá se prueban span de jQuery UI, input, button e imagen.
 */
async function clickAceptar(page: Page): Promise<boolean> {
  const [span] = await page.$$(
    'xpath/ .//span[@class="ui-button-text" and normalize-space(text())="Aceptar"]',
  );
  if (span) {
    await span.click();
    await span.dispose();
    return true;
  }
  return clickPorTexto(page, ['aceptar', 'guardar', 'confirmar']);
}

/** Click genérico por texto/value/alt sobre controles visibles. */
async function clickPorTexto(page: Page, textos: string[]): Promise<boolean> {
  return page.evaluate((textos: string[]) => {
    const norm = (s: string) =>
      (s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    const cands = Array.from(
      document.querySelectorAll<HTMLElement>(
        'input[type="button"], input[type="submit"], input[type="image"], button, span.ui-button-text, a[onclick], a[href]',
      ),
    );
    const visible = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        cs.visibility !== 'hidden' &&
        cs.display !== 'none'
      );
    };
    for (const objetivo of textos.map(norm)) {
      const hit = cands.find((el) => {
        if (!visible(el)) return false;
        const v = (el as HTMLInputElement).value || '';
        const alt = (el as HTMLImageElement).alt || '';
        return [v, el.textContent || '', alt].map(norm).includes(objetivo);
      });
      if (hit) {
        hit.scrollIntoView({ block: 'center' });
        hit.click();
        return true;
      }
    }
    return false;
  }, textos);
}

/**
 * Elige una opción de un `<select>` usando el criterio dado, en vez de mandar
 * un value fijo que puede no existir.
 */
async function elegirOpcion(
  page: Page,
  selector: string,
  criterio: (
    opts: { value: string; texto: string }[],
  ) => { value: string; texto: string } | undefined,
  descripcion: string,
): Promise<string> {
  await page.waitForSelector(selector, { timeout: config.scrapper.timeoutMs });
  const opts = await page.evaluate((sel: string) => {
    const el = document.querySelector<HTMLSelectElement>(sel);
    if (!el) return [];
    return Array.from(el.options).map((o) => ({
      value: o.value,
      texto: (o.textContent || '').replace(/\s+/g, ' ').trim(),
    }));
  }, selector);

  const elegida = criterio(opts.filter((o) => o.value !== ''));
  if (!elegida) {
    throw new AltaError(
      AltaErrorCode.PUNTO_VENTA_FALLIDO,
      `No hay una opción válida de ${descripcion} en ${selector}`,
      opts.map((o) => `${o.value}=${o.texto}`).join(' | '),
    );
  }

  await page.select(selector, elegida.value);
  logger.debug(`${selector} → ${elegida.value} (${elegida.texto})`);
  return elegida.texto || elegida.value;
}

/** Acepta los diálogos de confirmación que aparecen después del alta. */
async function confirmarDialogos(page: Page): Promise<void> {
  const selectores = [
    '#JqueryInfoDialog_btnYes',
    '#JqueryConfirmDialog_btnYes',
    '#dlgConfirmacion_btnAceptar',
  ];
  for (const sel of selectores) {
    const btn = await page
      .waitForSelector(sel, { timeout: 6_000, visible: true })
      .catch(() => null);
    if (btn) {
      await btn.click().catch(() => {});
      await btn.dispose();
      await sleep(2_500);
    }
  }
  // Último recurso: cualquier "Aceptar"/"Sí" que haya quedado abierto.
  await clickPorTexto(page, ['si', 'aceptar']);
  await sleep(1_500);
}

/** Texto del cartel de error del formulario, si AFIP rechazó el alta. */
async function leerErrorFormulario(page: Page): Promise<string | undefined> {
  const txt = await page.evaluate(() => {
    const sels = [
      '.ui-state-error',
      '.error',
      '#lblError',
      'font[color="red"]',
      '.alert-danger',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      const t = el?.textContent?.trim();
      if (t) return t;
    }
    return '';
  });
  return txt || undefined;
}

/**
 * Condición del contribuyente según los puntos de venta que ya tiene.
 * Sólo devuelve algo si TODOS los vigentes coinciden: si están mezclados, es
 * mejor no saber que saber mal.
 */
function condicionDesdeGrilla(filas: FilaPdv[]): Condicion | null {
  const votos = filas
    .filter((f) => !f.baja)
    .map((f) => condicionDe(f.descripcion))
    .filter((c): c is Condicion => c !== null);
  const unicos = new Set(votos);
  return unicos.size === 1 ? [...unicos][0] : null;
}

/**
 * Elige el sistema de facturación del punto de venta nuevo.
 *
 * Acá estaba el bug de "el punto de venta se creó mal": el criterio anterior
 * era `MAW, y si no está, la primera opción que diga "Web Services"`. En el
 * combo de AFIP las opciones de Exento en IVA aparecen antes que las de
 * Monotributo, así que a un monotributista sin MAW le creaba un punto de venta
 * de EXENTO — válido para AFIP, inservible para el cliente, y sin ningún aviso.
 *
 * Ahora se elige por condición y, si no se puede determinar sin ambigüedad, se
 * corta y se pide intervención en vez de adivinar.
 */
async function elegirSistema(
  ctx: RunContext,
  page: Page,
  condicion: Condicion | null,
): Promise<string> {
  const selector = '#frmAlta_sisCodigo';
  const opts = await leerOpciones(page, selector);
  logger.log(
    `${ctx.cuit}: sistemas ofrecidos por AFIP → ${opts
      .map((o) => `${o.value}=${o.texto}`)
      .join(' | ')}`,
  );

  const wsOpts = opts.filter((o) => ES_WEB_SERVICE(o.texto));
  const fallar = (motivo: string): never => {
    throw new AltaError(
      AltaErrorCode.PUNTO_VENTA_FALLIDO,
      `No se puede elegir el sistema de facturación sin adivinar: ${motivo}`,
      `condición inferida: ${condicion ?? 'indeterminada'}. ` +
        `Opciones Web Services: ${wsOpts.map((o) => `${o.value}=${o.texto}`).join(' | ') || '(ninguna)'}. ` +
        `Para forzar una, mandar opciones.sistemaPuntoVenta en /api/altas.`,
    );
  };

  // 0) Override explícito del operador: gana sobre todo.
  const forzado = ctx.opts.sistemaPuntoVenta?.trim();
  if (forzado) {
    const hit =
      opts.find((o) => o.value === forzado) ??
      opts.find((o) => normalize(o.texto).includes(normalize(forzado)));
    if (!hit) fallar(`el sistema forzado "${forzado}" no está en el combo`);
    return seleccionar(page, selector, hit!);
  }

  if (wsOpts.length === 0) {
    fallar('AFIP no ofrece ningún sistema de Web Services para este CUIT');
  }

  // 1) Si AFIP ofrece UNA sola opción de Web Services, no hay nada que decidir:
  //    esa es. AFIP sólo ofrece los sistemas que le corresponden al
  //    contribuyente, así que su lista pesa más que la grilla — los puntos de
  //    venta viejos pueden ser de un régimen que la persona ya dejó.
  if (wsOpts.length === 1) {
    const unica = wsOpts[0];
    const suCondicion = condicionDe(unica.texto);
    if (condicion && suCondicion && suCondicion !== condicion) {
      // No bloquea, pero queda en el reporte para que alguien lo mire.
      ctx.warnings.push(
        `[punto de venta] los puntos de venta previos son de "${condicion}" y ` +
          `AFIP sólo ofrece "${unica.texto}". Probablemente el contribuyente ` +
          `cambió de régimen y los anteriores quedaron viejos, pero conviene ` +
          `confirmarlo contra el padrón.`,
      );
      logger.warn(
        `${ctx.cuit}: única opción WS (${suCondicion}) no coincide con la grilla (${condicion})`,
      );
    }
    return seleccionar(page, selector, unica);
  }

  // 2) Hay más de una: ahí sí hace falta la condición, y tiene que matchear
  //    exactamente una opción.
  if (condicion) {
    const match = wsOpts.filter((o) => condicionDe(o.texto) === condicion);
    if (match.length === 1) return seleccionar(page, selector, match[0]);
    if (match.length > 1) {
      fallar(`hay ${match.length} sistemas Web Services para "${condicion}"`);
    }
    fallar(
      `los puntos de venta previos son de "${condicion}" pero AFIP no ofrece ` +
        `ese sistema, y hay ${wsOpts.length} alternativas`,
    );
  }

  return fallar(
    'no se pudo determinar la condición del contribuyente y hay más de un sistema Web Services',
  );
}

/** Lee las opciones no vacías de un `<select>`. */
async function leerOpciones(
  page: Page,
  selector: string,
): Promise<{ value: string; texto: string }[]> {
  await page.waitForSelector(selector, { timeout: config.scrapper.timeoutMs });
  const opts = await page.evaluate((sel: string) => {
    const el = document.querySelector<HTMLSelectElement>(sel);
    if (!el) return [];
    return Array.from(el.options).map((o) => ({
      value: o.value,
      texto: (o.textContent || '').replace(/\s+/g, ' ').trim(),
    }));
  }, selector);
  return opts.filter((o) => o.value !== '');
}

/** Aplica la opción elegida y devuelve su descripción. */
async function seleccionar(
  page: Page,
  selector: string,
  opcion: { value: string; texto: string },
): Promise<string> {
  await page.select(selector, opcion.value);
  logger.log(`${selector} → ${opcion.value} (${opcion.texto})`);
  return opcion.texto || opcion.value;
}

/** Vuelve a leer la grilla y confirma que el punto de venta quedó creado. */
async function verificarAlta(
  page: Page,
  numero: number,
  sistemaEsperado: string,
): Promise<boolean> {
  const esperado = condicionDe(sistemaEsperado);
  await sleep(3_000);
  for (let i = 0; i < 3; i++) {
    const filas = await leerGrilla(page);
    const fila = filas.find((f) => f.numero === numero && !f.baja);
    if (fila) {
      // No alcanza con que sea "web services": tiene que ser el sistema que
      // elegimos. Si AFIP dio de alta otra cosa, el punto de venta quedó mal.
      const ok =
        ES_WEB_SERVICE(fila.descripcion) &&
        condicionDe(fila.descripcion) === esperado;
      if (!ok) {
        logger.warn(
          `Punto de venta ${numero} quedó como "${fila.descripcion}" y se pidió "${sistemaEsperado}"`,
        );
      }
      return ok;
    }
    await sleep(2_500);
  }
  return false;
}

/**
 * "Administrador de Relaciones de Clave Fiscal": habilita un web service sobre
 * el Computador Fiscal (certificado) del contribuyente.
 *
 * Se usa dos veces por alta:
 *   - WebServices > Facturación Electrónica            (para facturar)
 *   - WebServices > Consulta y lectura de Comunicaciones (WSCCOMU / e-Ventanilla)
 *
 * El grueso de los selectores viene de
 * `estudio-backend/scripts/lib/adherir-relacion.ts`, que ya está probado
 * end-to-end contra el portal real; acá está portado de Playwright a Puppeteer.
 *
 * Diferencia crítica contra el scrapper original: la elección del Computador
 * Fiscal. El original hacía `select.selectedIndex = 1` a ciegas, y los CUIT que
 * tienen varios certificados terminaban con el servicio habilitado sobre el
 * computador equivocado. Eso es exactamente lo que después explota al leer el
 * DFE con `coe.notAuthorized: Computador no autorizado a acceder al servicio`.
 * Acá se exige el alias EXACTO que se creó en esta misma corrida.
 */
import { Page } from 'puppeteer';
import { Logger } from '@nestjs/common';
import { config } from '../../config/config';
import { AltaError, AltaErrorCode, RunContext } from '../altas.types';
import { esperarEstable, normalize, shot, sleep } from './portal';

const logger = new Logger('AfipRelaciones');

export interface RelacionConfig {
  /** Ruta en el árbol de servicios: grupo → servicio. */
  serviceLabels: string[];
  /** Alias EXACTO del computador fiscal a autorizar. */
  aliasExacto: string;
  /** Prefijo para las capturas ('fe' | 'wsccomu'). */
  etiqueta: string;
}

export interface RelacionResult {
  ok: boolean;
  /** true si ARCA indicó que la relación ya existía (idempotente). */
  yaExistia?: boolean;
  /**
   * true cuando AFIP todavía no lista el Computador Fiscal. Pasa con el
   * certificado recién creado: tarda en publicarse en Administrador de
   * Relaciones. Vale la pena reintentar; el resto de los fallos no.
   */
  computadorNoPublicado?: boolean;
  detalle: string;
  computador?: string;
}

export const SERVICIO_FE = ['WebServices', 'Facturación Electrónica'];
export const SERVICIO_WSCCOMU = [
  'WebServices',
  'Consulta y lectura de Comunicaciones',
];

// ── Helpers que corren en el browser ────────────────────────────────────────

/** Clickea el primer elemento visible cuyo texto contiene `texto`. */
async function clickByText(page: Page, texto: string): Promise<boolean> {
  const handle = await page.evaluateHandle((objetivo: string) => {
    const normJs = (s: string) =>
      (s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    const candidatos = Array.from(
      document.querySelectorAll('a, td, span, label, div, li'),
    );
    const match = candidatos
      .filter((el) => normJs(el.textContent || '').includes(objetivo))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          cs.visibility !== 'hidden' &&
          cs.display !== 'none'
        );
      })
      // El nodo hoja (menos texto) es el más específico.
      .sort(
        (a, b) => (a.textContent || '').length - (b.textContent || '').length,
      )[0];
    if (match) match.scrollIntoView({ block: 'center' });
    return match || null;
  }, normalize(texto));

  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    return false;
  }
  await el.evaluate((n: Element) => (n as HTMLElement).click());
  await handle.dispose();
  return true;
}

/**
 * Clickea el logo del organismo ARCA en "Selección de Servicio a Habilitar".
 * Los organismos son IMÁGENES, no texto: se matchea por alt/title/src y se
 * descartan el logo del header y el menú lateral por posición.
 */
async function clickOrganismoArca(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));

    const esArca = (im: HTMLImageElement) => {
      const meta = `${im.alt} ${im.title} ${im.src}`.toLowerCase();
      return (
        meta.includes('control aduanero') ||
        meta.includes('administracion federal') ||
        /\barca\b/.test(meta) ||
        /[/_-]arca[/._-]/.test(meta)
      );
    };

    const target = imgs.filter((im) => {
      if (!esArca(im)) return false;
      const r = im.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left > 150 && r.top > 60;
    })[0];
    if (!target) return false;

    const clickable =
      target.closest<HTMLElement>(
        'a, [onclick], tr, td, div[role="button"], button',
      ) ?? target;
    clickable.scrollIntoView({ block: 'center' });
    clickable.click();
    return true;
  });
}

/** Selecciona al titular en cualquier combo de contribuyente visible. */
async function elegirContribuyente(
  page: Page,
  cuit: string,
  nombre?: string,
): Promise<boolean> {
  return page.evaluate(
    ({ cuit, nombre }: { cuit: string; nombre?: string }) => {
      const digits = cuit.replace(/\D/g, '');
      const nom = (nombre || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const r = sel.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const opts = Array.from(sel.options);
        const idx = opts.findIndex((o) => {
          const t = (o.textContent || '').toLowerCase();
          const v = (o.value || '').replace(/\D/g, '');
          return (
            (!!digits &&
              (v === digits || t.replace(/\D/g, '').includes(digits))) ||
            (nom.length > 4 && t.includes(nom))
          );
        });
        if (idx >= 0) {
          sel.selectedIndex = idx;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    },
    { cuit, nombre },
  );
}

/**
 * Clickea el primer control que coincide con alguno de `textos`. Los botones
 * de AFIP (BUSCAR, CONFIRMAR) suelen ser imágenes o enlaces, no `<input>` con
 * texto: se matchea por value/text/alt/title/name/id/src.
 */
async function clickBoton(page: Page, textos: string[]): Promise<boolean> {
  return page.evaluate((textos: string[]) => {
    const normJs = (s: string) =>
      (s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\s\u00a0]+/g, ' ')
        .trim()
        .toLowerCase();
    const cands = Array.from(
      document.querySelectorAll<HTMLElement>(
        'input[type="button"], input[type="submit"], input[type="image"], button, a[href], a[onclick], [onclick], img',
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
    const clickEl = (el: HTMLElement) => {
      const t =
        el.tagName === 'IMG'
          ? (el.closest<HTMLElement>('a, [onclick]') ?? el)
          : el;
      t.scrollIntoView({ block: 'center' });
      t.click();
    };
    const attr = (el: HTMLElement, k: string) =>
      (el as unknown as Record<string, unknown>)[k] as string | undefined;
    const exactoDe = (el: HTMLElement) =>
      [
        attr(el, 'value'),
        el.textContent,
        attr(el, 'alt'),
        attr(el, 'title'),
      ].map((v) => normJs(v || ''));
    const metaDe = (el: HTMLElement) =>
      normJs(
        ['value', 'alt', 'title', 'name', 'id', 'src']
          .map((k) => attr(el, k) || '')
          .concat(el.textContent || '')
          .join(' '),
      );

    for (const objetivo of textos.map(normJs)) {
      const exact = cands.find(
        (el) => visible(el) && exactoDe(el).some((v) => v === objetivo),
      );
      if (exact) {
        clickEl(exact);
        return true;
      }
    }
    for (const objetivo of textos.map(normJs)) {
      const partial = cands.find(
        (el) => visible(el) && metaDe(el).includes(objetivo),
      );
      if (partial) {
        clickEl(partial);
        return true;
      }
    }
    return false;
  }, textos);
}

/**
 * En "Incorporar nueva Relación", clickea el BUSCAR de la fila "Representante"
 * (no el de "Servicio"): es el que abre la selección del Computador Fiscal.
 */
async function clickBuscarRepresentante(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const normJs = (s: string) =>
      (s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\s\u00a0]+/g, ' ')
        .trim()
        .toLowerCase();

    const clickIn = (scope: Element): boolean => {
      const ctrl =
        scope.querySelector<HTMLElement>(
          'input[type="button"], input[type="submit"], input[type="image"], button',
        ) ||
        scope.querySelector<HTMLElement>('a[href], a[onclick], [onclick]') ||
        scope.querySelector<HTMLElement>('img');
      if (!ctrl) return false;
      const target =
        ctrl.tagName === 'IMG'
          ? (ctrl.closest<HTMLElement>('a, [onclick]') ?? ctrl)
          : ctrl;
      target.scrollIntoView({ block: 'center' });
      target.click();
      return true;
    };

    // 1) La fila cuyo label (celda 0) es "Representante".
    const rows = Array.from(document.querySelectorAll('tr'));
    const row = rows.find((r) => {
      const cells = Array.from(r.querySelectorAll('td, th'));
      if (!cells.length) return false;
      const label = normJs(cells[0].textContent || '');
      return label === 'representante' || label.startsWith('representante ');
    });
    if (row && clickIn(row)) return true;

    // 2) Fallback: el ÚLTIMO "BUSCAR" de la página (Representante va debajo
    //    de Servicio).
    const controles = Array.from(
      document.querySelectorAll<HTMLElement>(
        'input[type="button"], input[type="submit"], input[type="image"], button, a[href], a[onclick], [onclick], img',
      ),
    );
    const buscars = controles.filter((el) => {
      const r = el as unknown as Record<string, unknown>;
      const meta = `${(r.value as string) ?? ''} ${el.textContent ?? ''} ${(r.alt as string) ?? ''} ${(r.title as string) ?? ''} ${(r.src as string) ?? ''}`;
      return normJs(meta).includes('buscar');
    });
    if (buscars.length) {
      const last = buscars[buscars.length - 1];
      last.scrollIntoView({ block: 'center' });
      last.click();
      return true;
    }
    return false;
  });
}

/**
 * Elige el Computador Fiscal por alias EXACTO. Si no está el exacto, cae a
 * substring pero lo avisa: autorizar el computador equivocado es peor que
 * fallar, porque el error recién aparece meses después al leer el DFE.
 */
async function seleccionarComputador(
  page: Page,
  aliasExacto: string,
): Promise<{
  ok: boolean;
  exacto: boolean;
  elegido?: string;
  disponibles: string[];
}> {
  return page.evaluate((alias: string) => {
    const norm = (s: string | null | undefined) =>
      (s || '').replace(/\s+/g, ' ').trim();
    const target = norm(alias).toLowerCase();
    const selects = Array.from(document.querySelectorAll('select'));

    const aplicar = (sel: HTMLSelectElement, opt: HTMLOptionElement) => {
      sel.value = opt.value;
      sel.selectedIndex = Array.from(sel.options).indexOf(opt);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // 1) Coincidencia exacta.
    for (const sel of selects) {
      const opts = Array.from(sel.options);
      const exacta = opts.find(
        (o) => norm(o.textContent).toLowerCase() === target,
      );
      if (exacta) {
        aplicar(sel, exacta);
        return {
          ok: true,
          exacto: true,
          elegido: norm(exacta.textContent),
          disponibles: opts.map((o) => norm(o.textContent)),
        };
      }
    }
    // 2) Substring (último recurso).
    for (const sel of selects) {
      const opts = Array.from(sel.options);
      const matches = opts.filter((o) =>
        norm(o.textContent).toLowerCase().includes(target),
      );
      if (matches.length) {
        const elegido = matches[matches.length - 1];
        aplicar(sel, elegido);
        return {
          ok: true,
          exacto: false,
          elegido: norm(elegido.textContent),
          disponibles: opts.map((o) => norm(o.textContent)),
        };
      }
    }
    return {
      ok: false,
      exacto: false,
      disponibles: selects.flatMap((s) =>
        Array.from(s.options).map((o) => norm(o.textContent)),
      ),
    };
  }, aliasExacto);
}

/** Confirma cualquier diálogo posterior típico de ARCA (best-effort). */
async function confirmarDialogo(page: Page): Promise<void> {
  await sleep(1_200);
  const selectores = [
    '#JqueryInfoDialog_btnYes',
    '#dlgConfirmacion_btnAceptar',
    'input[value="Confirmar"]',
    'input[value="Aceptar"]',
  ];
  for (const sel of selectores) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click().catch(() => {});
      await btn.dispose();
      await sleep(1_000);
      return;
    }
  }
}

// ── Flujo ───────────────────────────────────────────────────────────────────

/**
 * Genera una relación de servicio sobre el computador fiscal indicado.
 * `page` tiene que ser la pestaña de "Administrador de Relaciones" recién
 * abierta desde el buscador del portal.
 */
export async function adherirRelacion(
  ctx: RunContext,
  page: Page,
  cfg: RelacionConfig,
): Promise<RelacionResult> {
  const timeout = config.scrapper.timeoutMs;
  page.setDefaultTimeout(timeout);
  const tag = cfg.etiqueta;
  await shot(page, ctx.shotsDir, `${tag}-00-abierto`);

  // 1) "Autoridad de Aplicación": elegir al titular si lo pide. El combo
  //    dispara un postback, así que hay que esperar a que la página se rehaga
  //    antes de buscar nada (si no: "Execution context was destroyed").
  if (await elegirContribuyente(page, ctx.cuit, ctx.realName)) {
    await esperarEstable(page);
    if (!(await page.$('#cmdNuevaRelacion'))) {
      await clickBoton(page, ['confirmar', 'ingresar', 'continuar', 'aceptar']);
      await esperarEstable(page);
    }
  }

  // 2) Nueva relación.
  try {
    await page.waitForSelector('#cmdNuevaRelacion', { timeout: 15_000 });
  } catch {
    await shot(page, ctx.shotsDir, `${tag}-01-sin-nueva-relacion`);
    // Sin representación sobre la persona jurídica no se llega ni al formulario.
    const txt = normalize(await page.content());
    if (txt.includes('no posee') || txt.includes('no tiene relaciones')) {
      throw new AltaError(
        AltaErrorCode.REPRESENTACION_REQUERIDA,
        'El CUIT no puede operar en Administrador de Relaciones (falta la representación)',
      );
    }
    throw new AltaError(
      AltaErrorCode.TIMEOUT,
      'No apareció el botón "Nueva Relación"',
    );
  }
  await Promise.all([
    page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 })
      .catch(() => null),
    page.click('#cmdNuevaRelacion'),
  ]);
  await esperarEstable(page);

  // 3) Representado (segundo combo, si aparece).
  if (await elegirContribuyente(page, ctx.cuit, ctx.realName)) {
    await esperarEstable(page);
  }

  // Verificación de representación: el label tiene que traer el CUIT propio.
  const lblRepresentado = await page.$('#tblDetalleRelacion_lblRepresentado');
  if (lblRepresentado) {
    const texto = await page.evaluate(
      (el) => el.textContent?.trim() || '',
      lblRepresentado,
    );
    await lblRepresentado.dispose();
    const cuitFormateado = `${ctx.cuit.slice(0, 2)}-${ctx.cuit.slice(2, 10)}-${ctx.cuit.slice(10)}`;
    if (texto && !texto.includes(cuitFormateado) && !texto.includes(ctx.cuit)) {
      await shot(page, ctx.shotsDir, `${tag}-01-representado-ajeno`);
      throw new AltaError(
        AltaErrorCode.REPRESENTACION_REQUERIDA,
        'El usuario debe activar la representación hacia su persona jurídica',
        texto,
      );
    }
  }

  // 4) Buscar servicio → árbol de organismos.
  await page.waitForSelector('#cmdBuscarServicio', { timeout: 15_000 });
  await Promise.all([
    page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 })
      .catch(() => null),
    page.click('#cmdBuscarServicio'),
  ]);
  await esperarEstable(page);
  await shot(page, ctx.shotsDir, `${tag}-02-arbol`);

  // 5) Organismo ARCA (logo/imagen).
  if (!(await clickOrganismoArca(page))) {
    await shot(page, ctx.shotsDir, `${tag}-02-sin-organismo`);
    return {
      ok: false,
      detalle: 'No se encontró el logo del organismo ARCA en la lista',
    };
  }
  await sleep(3_000);
  await shot(page, ctx.shotsDir, `${tag}-03-post-arca`);

  // 6) Ruta grupo → servicio.
  for (const label of cfg.serviceLabels) {
    if (!(await clickByText(page, label))) {
      await shot(page, ctx.shotsDir, `${tag}-03-sin-servicio`);
      return {
        ok: false,
        detalle: `No se encontró el nodo "${label}" en el árbol de servicios`,
      };
    }
    await sleep(2_500);
  }
  await sleep(1_500);
  await shot(page, ctx.shotsDir, `${tag}-04-incorporar`);

  // 7) BUSCAR de la fila "Representante" → selección del Computador Fiscal.
  if (!(await clickBuscarRepresentante(page))) {
    await shot(page, ctx.shotsDir, `${tag}-04-sin-buscar-representante`);
    return {
      ok: false,
      detalle: 'No se encontró el botón BUSCAR de la fila "Representante"',
    };
  }
  await sleep(3_000);
  await shot(page, ctx.shotsDir, `${tag}-05-representante`);

  const contenido = normalize(await page.content());
  if (contenido.includes('no cuenta con computadores fiscales')) {
    await shot(page, ctx.shotsDir, `${tag}-05-sin-computador`);
    return {
      ok: false,
      computadorNoPublicado: true,
      detalle:
        'AFIP todavía no lista ningún Computador Fiscal para este CUIT ' +
        '(el certificado recién creado puede tardar en publicarse)',
    };
  }

  // 8) Elegir el computador por alias EXACTO.
  const comp = await seleccionarComputador(page, cfg.aliasExacto);
  if (!comp.ok) {
    await shot(page, ctx.shotsDir, `${tag}-05-computador-no-encontrado`);
    return {
      ok: false,
      // Combo vacío = mismo caso que arriba: AFIP no publicó el computador
      // todavía. Con opciones pero sin la nuestra, es otra cosa (alias mal).
      computadorNoPublicado: comp.disponibles.length === 0,
      detalle:
        `No se encontró el Computador Fiscal "${cfg.aliasExacto}". ` +
        `Opciones en pantalla: ${comp.disponibles.join(' | ') || '(ninguna)'}`,
    };
  }
  if (!comp.exacto) {
    ctx.warnings.push(
      `[${tag}] el alias exacto "${cfg.aliasExacto}" no estaba en el combo; ` +
        `se autorizó "${comp.elegido}". Verificar con mapear-computadores.ts.`,
    );
    logger.warn(
      `${ctx.cuit}: computador elegido por substring (${comp.elegido})`,
    );
  }
  await page.waitForNetworkIdle({ timeout: 15_000 }).catch(() => {});
  await sleep(2_500);
  await shot(page, ctx.shotsDir, `${tag}-06-computador`);

  // 9) CONFIRMAR, con reintentos porque el re-render tarda.
  let confirmado = false;
  for (let intento = 0; intento < 5 && !confirmado; intento++) {
    confirmado = await clickBoton(page, [
      'confirmar',
      'generar relacion',
      'generar',
    ]);
    if (!confirmado) await sleep(2_000);
  }
  if (!confirmado) {
    await shot(page, ctx.shotsDir, `${tag}-06-sin-confirmar`);
    return {
      ok: false,
      computador: comp.elegido,
      detalle: `Computador elegido (${comp.elegido}) pero no apareció el botón CONFIRMAR`,
    };
  }
  await sleep(2_500);
  await shot(page, ctx.shotsDir, `${tag}-07-post-confirmar`);

  // 10) Confirmación final (a veces vuelve a pedirla).
  await clickBoton(page, ['confirmar', 'generar relacion', 'generar']);
  await confirmarDialogo(page);
  await sleep(2_000);
  await shot(page, ctx.shotsDir, `${tag}-08-resultado`);

  const fin = normalize(await page.content());
  const yaExistia =
    fin.includes('ya existe') ||
    fin.includes('ya posee') ||
    fin.includes('ya se encuentra') ||
    fin.includes('relacion existente') ||
    fin.includes('duplicad');

  return {
    ok: true,
    yaExistia,
    computador: comp.elegido,
    detalle: yaExistia
      ? `Ya estaba habilitado en AFIP (computador ${comp.elegido})`
      : `Relación generada correctamente (computador ${comp.elegido})`,
  };
}

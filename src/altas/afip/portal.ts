/**
 * Helpers de navegación del portal de ARCA/AFIP: launch, login verificado,
 * popups, modales y búsqueda de servicios.
 *
 * Diferencias importantes contra `src/scrapper/scrapper.service.ts` (que se
 * deja intacto porque está deployado):
 *
 *  - El login VERIFICA el resultado. El original hacía `click(btnIngresar)` y
 *    seteaba `loggedIn = true` sin mirar nada, así que una clave incorrecta se
 *    manifestaba 2 minutos después como un timeout indescifrable. Ahora se
 *    espera a que aparezca el portal o el cartel de error y se tira un
 *    AltaError tipado (CLAVE_INCORRECTA / USUARIO_BLOQUEADO / CAPTCHA).
 *  - Nada de estado en `this`: todo va por parámetro.
 *  - Capturas de pantalla en cada paso, para poder auditar los casos que
 *    terminan pidiendo intervención humana.
 */
import puppeteer, { Browser, Page } from 'puppeteer';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { Logger } from '@nestjs/common';
import { config } from '../../config/config';
import { AltaError, AltaErrorCode } from '../altas.types';

const logger = new Logger('AfipPortal');

export const LANDING_URL = 'https://www.afip.gob.ar/landing/default.asp';

/** Normaliza texto para comparar: sin acentos, sin dobles espacios, minúscula. */
export const normalize = (s: string | null | undefined): string =>
  (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Captura de pantalla best-effort: nunca hace fallar el flujo. */
export async function shot(
  page: Page | undefined,
  dir: string,
  name: string,
): Promise<void> {
  if (!page || page.isClosed()) return;
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(11, 23);
    await page.screenshot({
      path: join(dir, `${stamp}-${name}.png`) as `${string}.png`,
      fullPage: false,
    });
  } catch {
    /* una captura fallida no puede voltear la corrida */
  }
}

export async function launchBrowser(headless: boolean): Promise<Browser> {
  return puppeteer.launch({
    headless,
    slowMo: config.scrapper.slowMo || undefined,
    ...(config.scrapper.executablePath
      ? { executablePath: config.scrapper.executablePath }
      : {}),
    defaultViewport: { width: 1440, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1440,900',
    ],
  });
}

/** Espera una Page nueva creada después de registrarse (sin carreras). */
export function waitForNewPage(
  browser: Browser,
  opts: { timeoutMs?: number; mustHaveOpener?: boolean } = {},
): Promise<Page | null> {
  const { timeoutMs = 15_000, mustHaveOpener = true } = opts;

  return new Promise((resolve) => {
    const onCreated = async (t: {
      type: () => string;
      opener: () => unknown;
      page: () => Promise<Page | null>;
    }) => {
      try {
        if (t.type() !== 'page') return;
        if (mustHaveOpener && !t.opener()) return;
        const p = await t.page();
        if (!p) return;
        cleanup();
        resolve(p);
      } catch {
        /* seguir escuchando */
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      browser.off('targetcreated', onCreated as never);
    };

    browser.on('targetcreated', onCreated as never);
  });
}

/** Texto visible completo de la página (para detectar carteles de AFIP). */
async function pageText(page: Page): Promise<string> {
  try {
    return normalize(await page.evaluate(() => document.body?.innerText ?? ''));
  } catch {
    return '';
  }
}

/** Click por texto visible dentro de un contenedor, con click real. */
export async function clickButtonByText(
  page: Page,
  containerSel: string,
  targetText: string,
): Promise<boolean> {
  const container = await page.$(containerSel);
  if (!container) return false;

  const buttons = await page.$$(
    `${containerSel} button, ${containerSel} .btn, ${containerSel} a`,
  );
  const target = normalize(targetText);

  for (const btn of buttons) {
    const [txt, visible] = await Promise.all([
      page.evaluate((el) => el.textContent || '', btn),
      page.evaluate((el) => {
        const cs = getComputedStyle(el as HTMLElement);
        const r = (el as HTMLElement).getBoundingClientRect();
        return (
          cs.visibility !== 'hidden' &&
          cs.display !== 'none' &&
          r.width > 0 &&
          r.height > 0
        );
      }, btn),
    ]);
    if (visible && normalize(txt) === target) {
      await btn.evaluate((el: Element) =>
        (el as HTMLElement).scrollIntoView({ block: 'center' }),
      );
      await btn.click({ delay: 30 });
      await btn.dispose();
      return true;
    }
    await btn.dispose();
  }
  return false;
}

/** Cierra un modal si está presente. Puede esperar el popup que abre. */
export async function handleModalIfPresent(
  page: Page,
  buttonText: string,
  browser?: Browser,
  opts: { timeoutMs?: number } = {},
): Promise<Page | null> {
  const { timeoutMs = 12_000 } = opts;
  await sleep(600);

  const modal = await page.$('.modal-content');
  if (!modal) return null;

  const waitPopup = browser
    ? waitForNewPage(browser, { timeoutMs, mustHaveOpener: true })
    : null;

  const clicked = await clickButtonByText(page, '.modal-content', buttonText);
  if (!clicked) {
    logger.debug(`Botón "${buttonText}" no encontrado en el modal`);
    return null;
  }
  await sleep(500);

  if (!waitPopup) return null;
  const popup = await waitPopup;
  if (popup) {
    await popup.bringToFront().catch(() => {});
    await popup.waitForSelector('body', { timeout: 10_000 }).catch(() => {});
  }
  return popup;
}

// ── Login ───────────────────────────────────────────────────────────────────

/** Frases con las que AFIP contesta una clave incorrecta. */
const TXT_CLAVE_MAL = [
  'clave o usuario incorrecto',
  'usuario o clave incorrecto',
  'clave incorrecta',
  'datos incorrectos',
  'no coincide',
];

/** Frases de clave bloqueada / CUIT inexistente / usuario inhabilitado. */
const TXT_BLOQUEADO = [
  'clave bloqueada',
  'ha sido bloqueada',
  'clave inhabilitada',
  'usuario inhabilitado',
  'no se encuentra registrado',
  'no esta registrado',
  'debe blanquear',
  'clave vencida',
];

/**
 * Loguea en ARCA y devuelve la pestaña del portal (la que tiene el buscador).
 * Tira AltaError tipado si la clave está mal, si hay captcha o si el usuario
 * está bloqueado.
 */
export async function openArcaAndLogin(
  browser: Browser,
  cuit: string,
  clave: string,
  shotsDir: string,
): Promise<Page> {
  const timeout = config.scrapper.timeoutMs;
  const landing = await browser.newPage();
  landing.setDefaultTimeout(timeout);

  await landing.goto(LANDING_URL, { waitUntil: 'domcontentloaded' });
  await landing.waitForSelector('a.btn.btn-sm.btn-info.btn-block.uppercase', {
    timeout,
  });

  const waitLogin = waitForNewPage(browser, { timeoutMs: timeout });
  await landing.click('a.btn.btn-sm.btn-info.btn-block.uppercase');
  const login = (await waitLogin) ?? landing;
  await login.bringToFront().catch(() => {});
  login.setDefaultTimeout(timeout);

  await login.waitForFunction(() => document.readyState === 'complete');
  await shot(login, shotsDir, '01-login');

  // Paso 1: CUIT
  await login.waitForSelector('#F1\\:username', { timeout });
  await login.type('#F1\\:username', cuit, { delay: 20 });
  await login.click('#F1\\:btnSiguiente');

  // Si el CUIT no existe, AFIP se queda en el paso 1 con un cartel de error.
  try {
    await login.waitForSelector('#F1\\:password', { timeout });
  } catch {
    const txt = await pageText(login);
    await shot(login, shotsDir, '02-cuit-rechazado');
    if (TXT_BLOQUEADO.some((f) => txt.includes(f))) {
      throw new AltaError(
        AltaErrorCode.USUARIO_BLOQUEADO,
        'AFIP rechazó el CUIT (inexistente o inhabilitado)',
      );
    }
    throw new AltaError(
      AltaErrorCode.TIMEOUT,
      'No apareció el campo de clave después de ingresar el CUIT',
    );
  }

  await login.type('#F1\\:password', clave, { delay: 20 });

  // Captcha: si AFIP lo muestra, no hay nada que automatizar.
  await sleep(1_500);
  if (await login.$('#captcha img')) {
    await shot(login, shotsDir, '02-captcha');
    throw new AltaError(
      AltaErrorCode.CAPTCHA,
      'AFIP pidió captcha: requiere ingreso manual',
    );
  }

  await shot(login, shotsDir, '02-clave-cargada');
  await login.click('#F1\\:btnIngresar');

  // Carrera entre "entró al portal" y "AFIP mostró un cartel de error".
  const entro = await Promise.race([
    login
      .waitForFunction(
        () =>
          !!document.querySelector('#buscadorInput') ||
          location.host.includes('portalcf'),
        { timeout: timeout },
      )
      .then(() => true)
      .catch(() => false),
    (async () => {
      // Polling del texto: los ids del cartel de error de AFIP cambian seguido,
      // el texto no.
      const hasta = Date.now() + timeout;
      while (Date.now() < hasta) {
        const txt = await pageText(login);
        if ([...TXT_CLAVE_MAL, ...TXT_BLOQUEADO].some((f) => txt.includes(f))) {
          return false;
        }
        await sleep(700);
      }
      return false;
    })(),
  ]);

  if (!entro) {
    const txt = await pageText(login);
    await shot(login, shotsDir, '03-login-fallido');
    // La clave anduvo, pero AFIP interpone la pantalla obligatoria de cambio
    // de contraseña y no deja llegar al portal. No es un timeout ni una clave
    // incorrecta: hay que cambiarla a mano y actualizarla en la base.
    if (
      txt.includes('cambiar clave fiscal') ||
      txt.includes('tenes que cambiar tu contrasena') ||
      txt.includes('debe cambiar su clave')
    ) {
      throw new AltaError(
        AltaErrorCode.CLAVE_DEBE_CAMBIARSE,
        'AFIP obliga a cambiar la clave fiscal antes de entrar al portal',
        'La clave actual es correcta. Hay que cambiarla manualmente en AFIP y actualizarla en clients.password.',
      );
    }
    if (TXT_BLOQUEADO.some((f) => txt.includes(f))) {
      throw new AltaError(
        AltaErrorCode.USUARIO_BLOQUEADO,
        'Clave fiscal bloqueada o inhabilitada',
      );
    }
    if (TXT_CLAVE_MAL.some((f) => txt.includes(f))) {
      throw new AltaError(
        AltaErrorCode.CLAVE_INCORRECTA,
        'Clave fiscal incorrecta',
      );
    }
    if (await login.$('#captcha img')) {
      throw new AltaError(
        AltaErrorCode.CAPTCHA,
        'AFIP pidió captcha: requiere ingreso manual',
      );
    }
    throw new AltaError(
      AltaErrorCode.TIMEOUT,
      'No se pudo confirmar el ingreso al portal de ARCA',
    );
  }

  await shot(login, shotsDir, '03-portal');
  logger.log(`Login OK para ${cuit}`);
  return login;
}

// ── Búsqueda de servicios ───────────────────────────────────────────────────

/**
 * Busca un servicio en el buscador del portal y devuelve la pestaña que se
 * abre. Si el servicio no está habilitado para ese CUIT, el buscador no
 * ofrece resultados: eso se reporta como SERVICIO_NO_HABILITADO en vez de
 * como un timeout genérico (es el caso de "no tiene activadas ciertas áreas").
 */
export async function buscarServicio(
  browser: Browser,
  portal: Page,
  servicio: string,
  shotsDir: string,
  slug: string,
): Promise<Page> {
  const timeout = config.scrapper.timeoutMs;
  await portal.bringToFront().catch(() => {});
  await portal.waitForFunction(() => document.readyState === 'complete');

  // El portal abre modales ("Recordar más tarde") que tapan el buscador.
  await handleModalIfPresent(portal, 'recordar mas tarde');
  await handleModalIfPresent(portal, 'mas tarde');

  await portal.waitForSelector('#buscadorInput', { timeout: 30_000 });
  await portal.click('#buscadorInput', { delay: 20 });
  // Limpiar lo que haya quedado de una búsqueda anterior.
  await portal.evaluate(() => {
    const el = document.querySelector('#buscadorInput') as HTMLInputElement;
    if (el) el.value = '';
  });
  await portal.type('#buscadorInput', servicio, { delay: 45 });

  try {
    await portal.waitForSelector('#rbt-menu-item-0', { timeout: 15_000 });
  } catch {
    await shot(portal, shotsDir, `${slug}-sin-resultados`);
    throw new AltaError(
      AltaErrorCode.SERVICIO_NO_HABILITADO,
      `El servicio "${servicio}" no aparece en el buscador: probablemente no esté habilitado para este CUIT`,
    );
  }

  const waitPopup = waitForNewPage(browser, { timeoutMs: 15_000 });
  await portal.click('#rbt-menu-item-0', { delay: 30 });
  let nueva = await waitPopup;

  // A veces media una modal de confirmación que es la que abre el popup.
  if (!nueva) {
    nueva = await handleModalIfPresent(portal, 'continuar', browser, {
      timeoutMs: 15_000,
    });
  }
  // Y si tampoco, puede navegar en la misma pestaña.
  if (!nueva) {
    await Promise.race([
      portal
        .waitForNavigation({ waitUntil: 'networkidle0', timeout: 8_000 })
        .catch(() => null),
      sleep(1_500),
    ]);
    nueva = portal;
  }

  await nueva.bringToFront().catch(() => {});
  await nueva.waitForSelector('body', { timeout: 15_000 }).catch(() => {});
  nueva.setDefaultTimeout(timeout);
  await shot(nueva, shotsDir, `${slug}-abierto`);
  return nueva;
}

/**
 * Espera a que la página quede quieta, tolerando que AFIP esté navegando.
 *
 * Los servicios viejos de AFIP son WebForms: casi cualquier interacción
 * dispara un postback que destruye el contexto de ejecución. Sin esto, la
 * llamada siguiente muere con "Execution context was destroyed".
 */
export async function esperarEstable(
  page: Page,
  timeoutMs = 20_000,
): Promise<void> {
  const hasta = Date.now() + timeoutMs;
  while (Date.now() < hasta) {
    try {
      await page.waitForFunction(() => document.readyState === 'complete', {
        timeout: 5_000,
      });
      // Respiro extra: un postback puede encadenar más de una navegación.
      await sleep(800);
      const estado = await page.evaluate(() => document.readyState);
      if (estado === 'complete') return;
    } catch {
      await sleep(500);
    }
  }
}

/** Click en un selector si existe, esperando la navegación que dispare. */
export async function clickSiExiste(
  page: Page,
  selector: string,
): Promise<boolean> {
  const el = await page.$(selector).catch(() => null);
  if (!el) return false;
  await Promise.all([
    page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 })
      .catch(() => null),
    el.click().catch(() => null),
  ]);
  await el.dispose().catch(() => {});
  await esperarEstable(page);
  return true;
}

/**
 * Varios servicios de AFIP arrancan con la pantalla "Autoridad de Aplicación":
 * un combo para elegir el contribuyente por el que se va a operar. Elegirlo
 * dispara un postback, así que hay que esperar a que la página se rehaga.
 *
 * Devuelve true si seleccionó algo. Si no hay combo, no pasa nada: ese CUIT
 * opera en nombre propio y entra directo.
 */
export async function elegirRepresentado(
  page: Page,
  cuit: string,
): Promise<boolean> {
  const combos = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll('select'))
        .filter((s) => {
          const r = s.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((s) =>
          Array.from(s.options).map((o) =>
            (o.textContent || '').replace(/\s+/g, ' ').trim(),
          ),
        ),
    )
    .catch(() => [] as string[][]);

  const seleccionado = await page
    .evaluate((cuitBuscado: string) => {
      const digits = cuitBuscado.replace(/\D/g, '');
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const r = sel.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const opts = Array.from(sel.options);
        // Match por value o por texto: el combo a veces trae el CUIT con
        // guiones ("20-29266721-4") y a veces pelado.
        const idx = opts.findIndex((o) => {
          const v = (o.value || '').replace(/\D/g, '');
          const t = (o.textContent || '').replace(/\D/g, '');
          return v === digits || t.includes(digits);
        });
        if (idx >= 0) {
          sel.selectedIndex = idx;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, cuit)
    .catch(() => false);

  if (!seleccionado) {
    // Si HAY combo pero no está el CUIT propio, seguir con lo que AFIP dejó
    // preseleccionado es peligroso: el 2026-09-04 eso creó el certificado bajo
    // la sociedad que el cliente representa (CAPELLI AGUSTIN → CARNES CAPE SA),
    // y AFIP lo emitió con el CUIT de la sociedad. El certificado quedaba
    // guardado en Vault bajo la persona, y Administrador de Relaciones después
    // no encontraba ningún Computador Fiscal.
    if (combos.length > 0) {
      throw new AltaError(
        AltaErrorCode.REPRESENTACION_REQUERIDA,
        `El combo de "Autoridad de Aplicación" no ofrece el CUIT propio ${cuit}: ` +
          `sólo se puede operar en representación de terceros`,
        `Opciones: ${combos.flat().join(' | ') || '(vacío)'}`,
      );
    }
    return false;
  }

  logger.debug(`Representado ${cuit} elegido en Autoridad de Aplicación`);
  // El onchange del combo navega: esperar antes de tocar nada más.
  await page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 })
    .catch(() => null);
  await esperarEstable(page);
  return true;
}

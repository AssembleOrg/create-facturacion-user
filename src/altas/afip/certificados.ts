/**
 * "Administración de Certificados Digitales": crea el computador fiscal
 * (alias + CSR) y baja el .pem firmado por AFIP.
 *
 * Mejoras contra el original:
 *  - El CSR se genera en esta misma corrida, en un directorio propio. El
 *    original leía `static/uploads/csr-creado.pem`, un archivo global que había
 *    que crear antes con POST /cert/generate y que ese endpoint borraba entero
 *    en cada llamada: si el directorio no existía o quedaba vacío, el readdir
 *    explotaba con ENOENT y salía un 500 (el "error 500 al crear el pem").
 *  - `Page.setDownloadBehavior` se configura ANTES de disparar la descarga.
 *  - Se espera a que el archivo esté COMPLETO (sin .crdownload y con tamaño
 *    estable) en vez de asumir que a los 15 s ya bajó.
 *  - Si AFIP rechaza el CSR, se lee el cartel y se reporta como CERT_NO_CREADO
 *    con el texto real, en vez de un "Error adding alias" genérico.
 */
import { ElementHandle, Page } from 'puppeteer';
import { join } from 'path';
import { readFileSync, readdirSync, statSync } from 'fs';
import { Logger } from '@nestjs/common';
import { config } from '../../config/config';
import { AltaError, AltaErrorCode, RunContext } from '../altas.types';
import {
  clickSiExiste,
  elegirRepresentado,
  esperarEstable,
  normalize,
  shot,
  sleep,
} from './portal';

const logger = new Logger('AfipCertificados');

/** Nombre del CSR que se sube. Vive en el uploadsDir de la corrida. */
export const CSR_FILENAME = 'csr-creado.pem';
export const KEY_FILENAME = 'key-creado.pem';

/**
 * Da de alta el alias + CSR y descarga el certificado firmado.
 * Devuelve el contenido del .pem (certificado) descargado.
 */
export async function crearCertificado(
  ctx: RunContext,
  page: Page,
): Promise<string> {
  const timeout = config.scrapper.timeoutMs;
  page.setDefaultTimeout(timeout);
  await esperarEstable(page);

  // La primera pantalla es "Autoridad de Aplicación": un combo que dispara un
  // postback. Algunos CUIT entran directo y no lo tienen.
  await elegirRepresentado(page, ctx.cuit);
  await clickSiExiste(page, '#cmdIngresar');

  await shot(page, ctx.shotsDir, '10-certificados');

  try {
    await page.waitForSelector('#txtAliasCertificado', { timeout: 30_000 });
  } catch {
    await shot(page, ctx.shotsDir, '10-sin-formulario');
    throw new AltaError(
      AltaErrorCode.CERT_NO_CREADO,
      'No apareció el formulario de alta de certificado (¿el CUIT no tiene el servicio habilitado?)',
    );
  }

  // La pantalla dice para QUÉ CUIT va a emitir el certificado. Si no es el
  // nuestro, cortar acá: seguir deja un computador fiscal colgado en un
  // tercero y un certificado ajeno guardado bajo este cliente. Pasó el
  // 2026-09-04 con CAPELLI AGUSTIN → CARNES CAPE SA.
  const cuitDelFormulario = await page.evaluate(() => {
    const celdas = Array.from(document.querySelectorAll('td,th'));
    for (let i = 0; i < celdas.length - 1; i++) {
      if ((celdas[i].textContent || '').trim().toUpperCase() === 'CUIT') {
        return (celdas[i + 1].textContent || '').replace(/\D/g, '');
      }
    }
    return '';
  });
  if (cuitDelFormulario && cuitDelFormulario !== ctx.cuit) {
    await shot(page, ctx.shotsDir, '10-cuit-ajeno');
    throw new AltaError(
      AltaErrorCode.REPRESENTACION_REQUERIDA,
      `AFIP va a emitir el certificado para el CUIT ${cuitDelFormulario}, no para ${ctx.cuit}`,
      'La sesión quedó operando en representación de un tercero. No se creó nada.',
    );
  }

  await page.type('#txtAliasCertificado', ctx.alias, { delay: 20 });

  const csrPath = join(ctx.uploadsDir, CSR_FILENAME);
  await page.waitForSelector('#archivo', { visible: true, timeout });
  const fileInput = (await page.$(
    '#archivo',
  )) as ElementHandle<HTMLInputElement> | null;
  if (!fileInput) {
    throw new AltaError(
      AltaErrorCode.CERT_NO_CREADO,
      'No se encontró el input de archivo del CSR',
    );
  }
  await fileInput.uploadFile(csrPath);
  await fileInput.dispose();
  await shot(page, ctx.shotsDir, '11-csr-cargado');

  // Enviar el CSR navega: hay que esperar el postback antes de leer la grilla.
  await Promise.all([
    page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 })
      .catch(() => null),
    page.click('#cmdIngresar'),
  ]);
  await esperarEstable(page);
  await shot(page, ctx.shotsDir, '12-csr-enviado');

  // La descarga tiene que estar configurada antes de tocar nada.
  const cdp = await page.createCDPSession();
  await cdp.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: ctx.downloadsDir,
  });

  const fila = await buscarFilaAlias(page, ctx.alias);
  if (!fila) {
    const motivo = await leerCartelError(page);
    await shot(page, ctx.shotsDir, '12-cert-no-creado');
    throw new AltaError(
      AltaErrorCode.CERT_NO_CREADO,
      `AFIP no creó el certificado con alias ${ctx.alias}`,
      motivo,
    );
  }

  // Dentro de la fila, el <th> tiene el link al detalle del certificado.
  const link = (await fila.$('th a')) ?? (await fila.$('a'));
  if (!link) {
    throw new AltaError(
      AltaErrorCode.CERT_NO_DESCARGADO,
      'No se encontró el link al detalle del certificado',
    );
  }
  await Promise.all([
    page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 })
      .catch(() => null),
    link.click(),
  ]);
  await esperarEstable(page);
  await shot(page, ctx.shotsDir, '13-detalle-cert');

  try {
    await page.waitForSelector('input[alt="Descargar"]', {
      timeout: 40_000,
      visible: true,
    });
  } catch {
    await shot(page, ctx.shotsDir, '13-sin-boton-descargar');
    throw new AltaError(
      AltaErrorCode.CERT_NO_DESCARGADO,
      'No apareció el botón "Descargar" del certificado',
    );
  }
  await page.click('input[alt="Descargar"]');

  const pem = await esperarDescarga(ctx.downloadsDir);
  await shot(page, ctx.shotsDir, '14-cert-descargado');
  logger.log(`Certificado ${ctx.alias} descargado para ${ctx.cuit}`);
  return pem;
}

/** Busca en las tablas la fila cuyo primer <td> es exactamente el alias. */
async function buscarFilaAlias(
  page: Page,
  alias: string,
): Promise<ElementHandle<Element> | null> {
  await page.waitForSelector('table', { visible: true }).catch(() => {});
  // AFIP tarda en refrescar la grilla: se reintenta unos segundos.
  const hasta = Date.now() + 20_000;
  while (Date.now() < hasta) {
    const handle = await page.evaluateHandle((a: string) => {
      const norm = (s: string | null | undefined) =>
        (s || '')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      const tables = Array.from(document.querySelectorAll('table'));
      for (const table of tables) {
        for (const row of Array.from(table.querySelectorAll('tr'))) {
          const celdas = Array.from(row.querySelectorAll('td,th')).map((c) =>
            norm(c.textContent),
          );
          if (celdas.some((c) => c === a)) return row;
        }
      }
      return null;
    }, alias);
    const el = handle.asElement();
    if (el) return el as ElementHandle<Element>;
    await handle.dispose();
    await sleep(2_000);
  }
  return null;
}

/** Texto del cartel de error/aviso de AFIP, si lo hay. */
async function leerCartelError(page: Page): Promise<string | undefined> {
  try {
    const txt = await page.evaluate(() => {
      const sels = [
        '.error',
        '.alert',
        '#lblError',
        'font[color="red"]',
        '.ui-messages-error-detail',
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el?.textContent?.trim()) return el.textContent.trim();
      }
      return '';
    });
    return txt || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Espera a que aparezca un archivo descargado y COMPLETO.
 * Chromium escribe primero un `.crdownload`; el original leía el directorio
 * enseguida y se llevaba el parcial (o nada).
 */
async function esperarDescarga(
  dir: string,
  timeoutMs = 90_000,
): Promise<string> {
  const hasta = Date.now() + timeoutMs;
  let ultimoTamano = -1;
  let candidato: string | undefined;

  while (Date.now() < hasta) {
    const files = readdirSync(dir).filter(
      (f) => !f.endsWith('.crdownload') && !f.startsWith('.'),
    );
    if (files.length > 0) {
      // El más nuevo de todos.
      const conMtime = files
        .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      candidato = conMtime[0].f;
      const size = statSync(join(dir, candidato)).size;
      if (size > 0 && size === ultimoTamano) {
        const contenido = readFileSync(join(dir, candidato), 'utf-8');
        if (normalize(contenido).includes('begin certificate')) {
          return contenido;
        }
        throw new AltaError(
          AltaErrorCode.CERT_NO_DESCARGADO,
          'El archivo descargado no es un certificado PEM',
          contenido.slice(0, 200),
        );
      }
      ultimoTamano = size;
    }
    await sleep(1_500);
  }

  throw new AltaError(
    AltaErrorCode.CERT_NO_DESCARGADO,
    'La descarga del certificado no terminó a tiempo',
  );
}

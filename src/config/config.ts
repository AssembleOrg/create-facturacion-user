import dotenv from 'dotenv';
dotenv.config();

const bool = (v: string | undefined, def: boolean): boolean =>
  v === undefined || v === '' ? def : v.toLowerCase() === 'true';
const num = (v: string | undefined, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export const config = {
  vaultAddress: process.env.VAULT_ADDRESS,
  vaultToken: process.env.VAULT_TOKEN,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseApiKey: process.env.SUPABASE_API_KEY,

  /**
   * Clave estática para que procesos internos (el orquestador masivo) puedan
   * llamar a la API sin un JWT de Supabase. Si queda vacía, sigue exigiendo
   * el Bearer de Supabase como antes.
   */
  internalApiKey: (process.env.INTERNAL_API_KEY || '').trim(),

  scrapper: {
    /**
     * Poner en false para seguir la corrida a ojo (los casos que requieren
     * intervención humana se ven al toque y las capturas quedan igual).
     */
    headless: bool(process.env.SCRAPPER_HEADLESS, true),
    /** Milisegundos entre acciones cuando se corre headful, para poder mirar. */
    slowMo: num(process.env.SCRAPPER_SLOW_MO, 0),
    /** Chromium propio del sistema (en Docker: /usr/bin/chromium-browser). */
    executablePath: (process.env.PUPPETEER_EXECUTABLE_PATH || '').trim(),
    /** Timeout por defecto de los waitForSelector. */
    timeoutMs: num(process.env.SCRAPPER_TIMEOUT_MS, 20_000),
    /**
     * Si el certificado en Vault es más nuevo que esto, se reutiliza en vez de
     * crear uno nuevo. Los certificados de AFIP duran 2 años; el default de 14
     * días es conservador y es el que había desde el principio.
     */
    reuseCertDays: num(process.env.SCRAPPER_REUSE_CERT_DAYS, 14),
    /** Base para uploads/downloads/capturas por corrida. */
    workDir: (process.env.SCRAPPER_WORK_DIR || '').trim(),
    /**
     * Formato del serialNumber del CSR. AFIP documenta
     * `serialNumber=CUIT 20111111112` (con espacio); si alguna vez rechaza el
     * CSR, probar con `CUIT{cuit}`.
     */
    csrSerialFormat: process.env.CSR_SERIAL_FORMAT || 'CUIT {cuit}',
    /** Guardar una captura en cada etapa, no solo en los errores. */
    screenshotEveryStage: bool(process.env.SCRAPPER_SHOTS_ALL, true),
    /**
     * Intentos de la relación de servicio cuando AFIP todavía no publicó el
     * Computador Fiscal recién creado, y espera entre intentos. Medido el
     * 2026-09-04: le pasó a 3 de 30 altas.
     */
    relacionIntentos: num(process.env.SCRAPPER_RELACION_INTENTOS, 3),
    relacionEsperaMs: num(process.env.SCRAPPER_RELACION_ESPERA_MS, 60_000),
  },

  /** Archivo sqlite donde persisten los jobs (antes era :memory:). */
  jobsDb: (process.env.JOBS_DB_PATH || 'data/jobs.sqlite').trim(),
};

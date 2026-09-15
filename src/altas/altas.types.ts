/**
 * Tipos del flujo de alta masiva: etapas, códigos de error y contexto de una
 * corrida.
 *
 * Este módulo es una copia endurecida de `src/scrapper` — el original queda
 * intacto porque es el que está deployado. Acá se unifica TODO el alta en una
 * sola sesión de AFIP: certificado + relación de Facturación Electrónica +
 * relación de e-Ventanilla (WSCCOMU) + punto de venta.
 *
 * Tener etapas y códigos explícitos es lo que le permite al orquestador
 * (estudio-backend/scripts/crear-facturacion-masivo.ts) decir sin ambigüedad
 * qué pasó con cada CUIT: clave incorrecta, captcha, o —el caso importante—
 * "el certificado se creó pero la empresa no".
 */
import { Browser, Page } from 'puppeteer';

/** Etapas del flujo, en orden. `stage` guarda la ÚLTIMA completada. */
export enum AltaStage {
  INICIADO = 'iniciado',
  LOGIN_OK = 'login_ok',
  CSR_GENERADO = 'csr_generado',
  CERT_SUBIDO = 'cert_subido',
  CERT_DESCARGADO = 'cert_descargado',
  CERT_EN_VAULT = 'cert_en_vault',
  RELACION_FE = 'relacion_fe',
  RELACION_WSCCOMU = 'relacion_wsccomu',
  PUNTO_VENTA = 'punto_venta',
  COMPLETADO = 'completado',
}

/** Orden de las etapas, para comparar progreso. */
export const STAGE_ORDER: AltaStage[] = [
  AltaStage.INICIADO,
  AltaStage.LOGIN_OK,
  AltaStage.CSR_GENERADO,
  AltaStage.CERT_SUBIDO,
  AltaStage.CERT_DESCARGADO,
  AltaStage.CERT_EN_VAULT,
  AltaStage.RELACION_FE,
  AltaStage.RELACION_WSCCOMU,
  AltaStage.PUNTO_VENTA,
  AltaStage.COMPLETADO,
];

export const stageIndex = (s: AltaStage | string | undefined): number =>
  STAGE_ORDER.indexOf(s as AltaStage);

/**
 * Códigos de error estables. El orquestador agrupa por acá, así que NO
 * cambiar los valores sin actualizar el reporte del otro lado.
 */
export enum AltaErrorCode {
  /** La clave fiscal es incorrecta (AFIP mostró el cartel de error). */
  CLAVE_INCORRECTA = 'CLAVE_INCORRECTA',
  /** AFIP pidió captcha: requiere intervención humana. */
  CAPTCHA = 'CAPTCHA',
  /** Clave bloqueada / vencida / CUIT inexistente. */
  USUARIO_BLOQUEADO = 'USUARIO_BLOQUEADO',
  /**
   * La clave es CORRECTA pero AFIP obliga a cambiarla antes de entrar al
   * portal ("Por medidas de seguridad tenés que cambiar tu contraseña").
   * No se automatiza: cambiar la clave fiscal de un cliente es una decisión
   * del estudio, no del proceso.
   */
  CLAVE_DEBE_CAMBIARSE = 'CLAVE_DEBE_CAMBIARSE',
  /** No hay fila en facturacion_users para ese CUIT. */
  SIN_FACTURACION_USER = 'SIN_FACTURACION_USER',
  /** El CUIT no tiene habilitada la representación de la persona jurídica. */
  REPRESENTACION_REQUERIDA = 'REPRESENTACION_REQUERIDA',
  /** El servicio no está habilitado para ese CUIT (falta el área en AFIP). */
  SERVICIO_NO_HABILITADO = 'SERVICIO_NO_HABILITADO',
  /** No se pudo generar el par de claves / CSR. */
  CSR_FALLIDO = 'CSR_FALLIDO',
  /** AFIP no aceptó el CSR o no apareció el certificado en la grilla. */
  CERT_NO_CREADO = 'CERT_NO_CREADO',
  /** El certificado se creó en AFIP pero no se pudo descargar el .pem. */
  CERT_NO_DESCARGADO = 'CERT_NO_DESCARGADO',
  /** No se pudo escribir en Vault. */
  VAULT_FALLIDO = 'VAULT_FALLIDO',
  /** Falló la relación de Facturación Electrónica. */
  RELACION_FE_FALLIDA = 'RELACION_FE_FALLIDA',
  /** Falló la relación de e-Ventanilla (WSCCOMU). */
  RELACION_WSCCOMU_FALLIDA = 'RELACION_WSCCOMU_FALLIDA',
  /** Falló el alta / la lectura del punto de venta. */
  PUNTO_VENTA_FALLIDO = 'PUNTO_VENTA_FALLIDO',
  /** El botón de la empresa/contribuyente no matcheó, o matcheó ambiguo. */
  EMPRESA_NO_ENCONTRADA = 'EMPRESA_NO_ENCONTRADA',
  /** Timeout genérico del navegador. */
  TIMEOUT = 'TIMEOUT',
  DESCONOCIDO = 'DESCONOCIDO',
}

/** Error del flujo con código estable. */
export class AltaError extends Error {
  constructor(
    readonly code: AltaErrorCode,
    message: string,
    readonly detalle?: string,
  ) {
    super(message);
    this.name = 'AltaError';
  }
}

/** Qué pasos correr. Permite reintentar solo lo que falta de un CUIT. */
export interface AltaOptions {
  /** Crear el certificado (computador fiscal). Default true. */
  certificado: boolean;
  /** Relación de servicio de Facturación Electrónica. Default true. */
  relacionFe: boolean;
  /** Relación de servicio de e-Ventanilla / WSCCOMU (DFE). Default true. */
  relacionWsccomu: boolean;
  /** Alta o lectura del punto de venta. Default true. */
  puntoVenta: boolean;
  /** Correr con ventana visible (para los casos que piden intervención). */
  headless?: boolean;
  /**
   * Reusar el certificado que ya está en Vault si es reciente, en vez de
   * crear uno nuevo. Default true.
   */
  reusarCert?: boolean;
  /**
   * Fuerza el sistema del punto de venta (código como 'MAW', o un substring
   * del texto de la opción). Sirve para destrabar a mano un CUIT cuya
   * condición no se puede deducir de la grilla. Sin esto, ante la duda el
   * alta se corta en vez de elegir cualquiera.
   */
  sistemaPuntoVenta?: string;
}

export const DEFAULT_ALTA_OPTIONS: AltaOptions = {
  certificado: true,
  relacionFe: true,
  relacionWsccomu: true,
  puntoVenta: true,
  reusarCert: true,
};

/**
 * Estado de una corrida. Se pasa explícitamente por todo el flujo en vez de
 * vivir en campos de la instancia del servicio: en el scrapper original dos
 * jobs simultáneos se pisaban el alias, el punto de venta y hasta el browser.
 */
export interface RunContext {
  /** CUIT (facturacion_users.username). */
  cuit: string;
  /** Nombre en la base, usado para matchear el botón de la empresa en AFIP. */
  realName: string;
  /** id de facturacion_users: es la key del secreto en Vault. */
  facturacionUserId: string;
  browser: Browser;
  /** Pestaña del portal (la que tiene el buscador de servicios). */
  portal: Page;
  /** Alias del certificado de esta corrida (`new-csr-<timestamp>`). */
  alias: string;
  /** Directorio de descargas exclusivo de esta corrida. */
  downloadsDir: string;
  /** Directorio con el csr/key generados para esta corrida. */
  uploadsDir: string;
  /** Directorio donde se dejan las capturas de pantalla. */
  shotsDir: string;
  /** Última etapa completada. */
  stage: AltaStage;
  opts: AltaOptions;
  salePoint?: number;
  /** true si el punto de venta ya existía y no hubo que crearlo. */
  salePointPreexistente?: boolean;
  certEnVault?: boolean;
  /** true si el certificado ya estaba en Vault y se reusó (no se creó uno). */
  certReusado?: boolean;
  relacionFeOk?: boolean;
  relacionWsccomuOk?: boolean;
  /** Avisos no fatales que igual hay que reportar. */
  warnings: string[];
}

/** Resultado de una corrida completa. */
export interface RunResult {
  alias: string;
  salePoint?: number;
  salePointPreexistente: boolean;
  certEnVault: boolean;
  /** true si el certificado ya existía en Vault y se reusó. */
  certReusado: boolean;
  relacionFeOk: boolean;
  relacionWsccomuOk: boolean;
  stage: AltaStage;
  /**
   * true cuando hay certificado en Vault pero el resto del alta —relaciones de
   * servicio y/o punto de venta— no se completó. Es el caso que hay que avisar
   * sí o sí: en AFIP quedó un computador fiscal sin el alta terminada.
   */
  parcial: boolean;
  warnings: string[];
}

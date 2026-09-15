import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Un job = una corrida del alta para un CUIT.
 *
 * Tabla propia (`alta_jobs`) en un sqlite propio: el `jobs` del scrapper
 * original vive en `:memory:` y no se toca.
 *
 * Guarda bastante más que `status` porque el orquestador necesita distinguir
 * "no se pudo ni empezar" (clave incorrecta, captcha) de "se completó" y, sobre
 * todo, de "quedó a medias": el certificado se creó pero la empresa/punto de
 * venta no.
 */
@Entity('alta_jobs')
export class AltaJobEntity {
  @PrimaryGeneratedColumn()
  id: number;

  /** CUIT del contribuyente (= facturacion_users.username). */
  @Index()
  @Column()
  username: string;

  @Column({ nullable: true })
  realName?: string;

  /** pending | running | success | error */
  @Index()
  @Column({ default: 'pending' })
  status: string;

  /** Última etapa completada (ver AltaStage). */
  @Column({ nullable: true })
  stage?: string;

  /** Código estable de error (ver AltaErrorCode). Null si salió bien. */
  @Column({ nullable: true })
  errorCode?: string;

  @Column({ type: 'text', nullable: true })
  error?: string;

  /** Alias del certificado creado en AFIP (`new-csr-<timestamp>`). */
  @Column({ nullable: true })
  alias?: string;

  @Column({ type: 'int', nullable: true })
  salePoint?: number;

  /** true si el punto de venta ya existía y no hubo que crearlo. */
  @Column({ default: false })
  salePointPreexistente: boolean;

  /** true cuando key+cert quedaron escritos en Vault. */
  @Column({ default: false })
  certEnVault: boolean;

  /** true si el certificado ya estaba en Vault y se reusó (no se creó uno). */
  @Column({ default: false })
  certReusado: boolean;

  @Column({ default: false })
  relacionFeOk: boolean;

  @Column({ default: false })
  relacionWsccomuOk: boolean;

  /**
   * true cuando el certificado quedó creado pero el alta no se completó.
   * Es el caso que hay que avisar sí o sí: en AFIP quedó un computador fiscal
   * nuevo sin relación de servicio y/o sin punto de venta.
   */
  @Column({ default: false })
  parcial: boolean;

  /** Avisos no fatales, separados por salto de línea. */
  @Column({ type: 'text', nullable: true })
  warnings?: string;

  /** Directorio con las capturas de pantalla de la corrida. */
  @Column({ nullable: true })
  shotsDir?: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'datetime', nullable: true })
  startedAt?: Date;

  @Column({ type: 'datetime', nullable: true })
  finishedAt?: Date;
}

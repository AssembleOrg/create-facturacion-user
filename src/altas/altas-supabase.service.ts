/**
 * Acceso a Supabase para el flujo de altas.
 *
 * Es un servicio aparte del `SupabaseService` original a propósito: ese lo usa
 * el scrapper que está deployado y no se toca. Además necesita cosas que el
 * otro no tiene — crear la fila de `facturacion_users` cuando falta y marcar
 * `clients.ventanilla_adherida_at`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config } from '../config/config';

export interface FacturacionUser {
  id: number;
  username: string | null;
  password: string | null;
  real_name: string | null;
  category: string | null;
  salePoint: number | null;
  external_client: boolean | null;
  updated_at: string | null;
  created_at: string;
}

@Injectable()
export class AltasSupabaseService {
  private readonly logger = new Logger(AltasSupabaseService.name);
  private readonly db: SupabaseClient;

  constructor() {
    this.db = createClient(
      config.supabaseUrl ?? '',
      config.supabaseApiKey ?? '',
      { realtime: { transport: WebSocket as never } },
    );
  }

  /** Devuelve la fila o null. El original devolvía `data[0]` (undefined). */
  async getFacturacionUser(cuit: string): Promise<FacturacionUser | null> {
    const { data, error } = await this.db
      .from('facturacion_users')
      .select('*')
      .eq('username', cuit)
      .limit(1);

    if (error)
      throw new Error(`Supabase (facturacion_users): ${error.message}`);
    return (data?.[0] as FacturacionUser | undefined) ?? null;
  }

  /**
   * Devuelve la fila de facturacion_users, creándola si no existe.
   * `password` es la clave fiscal EN CLARO: así la guarda esta tabla (a
   * diferencia de `clients.password`, que va encriptada con ENCRYPTION_KEY).
   */
  async ensureFacturacionUser(
    cuit: string,
    datos: { realName: string; password: string; externalClient?: boolean },
  ): Promise<{ user: FacturacionUser; creado: boolean }> {
    const existente = await this.getFacturacionUser(cuit);
    if (existente) {
      // Si la clave cambió en `clients`, sincronizarla: el scrapper loguea con
      // la de acá y si quedó vieja da "clave incorrecta" para siempre.
      if (datos.password && existente.password !== datos.password) {
        await this.db
          .from('facturacion_users')
          .update({ password: datos.password })
          .eq('username', cuit);
        this.logger.log(`Clave de ${cuit} sincronizada desde clients`);
        existente.password = datos.password;
      }
      return { user: existente, creado: false };
    }

    const { data, error } = await this.db
      .from('facturacion_users')
      .insert({
        username: cuit,
        password: datos.password,
        real_name: datos.realName,
        external_client: datos.externalClient ?? false,
      })
      .select('*')
      .single();

    if (error) {
      // Síntoma conocido: la secuencia de `id` quedó atrás del max(id) porque
      // en algún momento se insertaron filas con id explícito. Sin esto,
      // TODOS los inserts fallan.
      const pista = error.message.includes('facturacion_users_pkey')
        ? ' — la secuencia de id está desfasada. Correr en Postgres: ' +
          "select setval('public.facturacion_users_id_seq', (select max(id) from facturacion_users));"
        : '';
      throw new Error(
        `No se pudo crear facturacion_users: ${error.message}${pista}`,
      );
    }
    this.logger.log(`facturacion_users creado para ${cuit} (id ${data.id})`);
    return { user: data as FacturacionUser, creado: true };
  }

  async updateSalePoint(cuit: string, salePoint: number): Promise<void> {
    const { error } = await this.db
      .from('facturacion_users')
      .update({ salePoint, updated_at: new Date().toISOString() })
      .eq('username', cuit);
    if (error)
      throw new Error(`No se pudo guardar el salePoint: ${error.message}`);
  }

  async touchUpdatedAt(cuit: string): Promise<void> {
    const { error } = await this.db
      .from('facturacion_users')
      .update({ updated_at: new Date().toISOString() })
      .eq('username', cuit);
    if (error)
      this.logger.warn(`No se pudo tocar updated_at: ${error.message}`);
  }

  /**
   * Marca en `clients` que el CUIT ya tiene el WS de e-Ventanilla adherido,
   * para que `scripts/adherir-ventanilla.ts` no lo vuelva a procesar.
   *
   * OJO: `clients` tiene RLS con una policy `deny_anon_clients`, así que esto
   * sólo funciona con una key `service_role`. Con la anon falla silenciosamente
   * (queda el warning). Por eso el orquestador masivo también lo marca por su
   * cuenta, yendo por Postgres directo; acá se deja como best-effort para
   * cuando se llama a /api/altas suelto.
   */
  async marcarVentanillaAdherida(cuit: string): Promise<void> {
    const { error } = await this.db
      .from('clients')
      .update({ ventanilla_adherida_at: new Date().toISOString() })
      .eq('username', cuit);
    if (error) {
      this.logger.warn(
        `No se pudo marcar ventanilla_adherida_at de ${cuit}: ${error.message}`,
      );
    }
  }
}

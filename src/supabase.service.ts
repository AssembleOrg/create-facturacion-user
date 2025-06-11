import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from 'src/config/config';
import { Database } from './types/supabase.types';

@Injectable()
export class SupabaseService {
  private supabase: SupabaseClient<Database>;
  private readonly logger = new Logger(SupabaseService.name);

  constructor() {
    const supabaseUrl = config.supabaseUrl ?? '';
    const supabaseKey = config.supabaseApiKey ?? '';

    this.supabase = createClient<Database>(supabaseUrl, supabaseKey);
  }

  async getFacturacionUser(
    username: string,
  ): Promise<Database['public']['Tables']['facturacion_users']['Row']> {
    const { data, error } = await this.supabase
      .from('facturacion_users')
      .select('*')
      .eq('username', username);

    if (error) {
      this.logger.error('Error fetching facturacion_users:', error.message);
      throw new BadRequestException(error.message);
    }

    if (!data) {
      this.logger.error('No data fetched from facturacion_users');
      throw new BadRequestException('No data fetched from facturacion_users');
    }

    const response: Database['public']['Tables']['facturacion_users']['Row'] =
      data[0];

    return response;
  }

  async updateFacturacionUser(
    username: string,
    data: Partial<Database['public']['Tables']['facturacion_users']['Row']>,
  ) {
    this.logger.verbose(username, JSON.stringify(data));
    const { error } = await this.supabase
      .from('facturacion_users')
      .update(data)
      .eq('username', username);

    if (error) {
      this.logger.error('Error updating facturacion_users:', error.message);
      throw new BadRequestException(error.message);
    }
  }

  async updateUpdatedAt(username: string): Promise<void> {
    const { error } = await this.supabase
      .from('facturacion_users')
      .update({ updated_at: new Date().toISOString() })
      .eq('username', username);

    if (error) {
      this.logger.error('Error updating updated_at:', error.message);
      throw new BadRequestException(error.message);
    }

    this.logger.log('Updated updated_at in facturacion_users');
  }

  async getFacturacionUsers(): Promise<
    Database['public']['Tables']['facturacion_users']['Row'][]
  > {
    const { data, error } = await this.supabase
      .from('facturacion_users')
      .select('*')
      .order('id', { ascending: true });

    if (error) {
      this.logger.error('Error fetching facturacion_users:', error.message);
      throw new BadRequestException(error.message);
    }

    if (!data) {
      this.logger.error('No data fetched from facturacion_users');
      throw new BadRequestException('No data fetched from facturacion_users');
    }

    const response: Database['public']['Tables']['facturacion_users']['Row'][] =
      data;

    return response;
  }
}

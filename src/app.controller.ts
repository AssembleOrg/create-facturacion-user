import { Controller, Get, Param, BadRequestException } from '@nestjs/common';
import { AppService } from './app.service';
import { SupabaseService } from './supabase.service';
import { Database } from './types/supabase.types';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly supabaseService: SupabaseService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('facturacion_users')
  async getAllFacturacionUsers(): Promise<
    Database['public']['Tables']['facturacion_users']['Row'][]
  > {
    return this.supabaseService.getFacturacionUsers();
  }

  @Get('facturacion_user/:username')
  async getFacturacionUser(
    @Param('username') username: string,
  ): Promise<Database['public']['Tables']['facturacion_users']['Row']> {
    if (!username) {
      throw new BadRequestException('El parámetro username es obligatorio.');
    }
    return this.supabaseService.getFacturacionUser(username);
  }
}

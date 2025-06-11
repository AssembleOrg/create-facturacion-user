import {
  Controller,
  Get,
  Param,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { AppService } from './app.service';
import { SupabaseService } from './supabase.service';
import { Database } from './types/supabase.types';
import { AuthGuard } from './guards/auth.guard';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly supabaseService: SupabaseService,
  ) {}

  @Get('status')
  getHello(): { status: string } {
    return {
      status: 'ok',
    };
  }

  @Get('facturacion_users')
  @UseGuards(AuthGuard)
  async getAllFacturacionUsers(): Promise<
    Database['public']['Tables']['facturacion_users']['Row'][]
  > {
    return this.supabaseService.getFacturacionUsers();
  }

  @Get('facturacion_user/:username')
  @UseGuards(AuthGuard)
  async getFacturacionUser(
    @Param('username') username: string,
  ): Promise<Database['public']['Tables']['facturacion_users']['Row']> {
    if (!username) {
      throw new BadRequestException('El parámetro username es obligatorio.');
    }
    return this.supabaseService.getFacturacionUser(username);
  }
}

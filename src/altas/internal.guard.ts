import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { SupabaseService } from '../supabase.service';
import { config } from '../config/config';

/**
 * Igual que el AuthGuard original, más un atajo por clave interna.
 *
 * El orquestador masivo corre como script y no tiene una sesión de Supabase;
 * pedirle un JWT obligaba a loguearse a mano cada hora en una corrida que dura
 * 10+ horas. Con `INTERNAL_API_KEY` seteada, alcanza el header `x-internal-key`.
 * Si la variable está vacía, el atajo no existe y sigue rigiendo el Bearer.
 */
@Injectable()
export class InternalOrAuthGuard implements CanActivate {
  constructor(private readonly supabaseService: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const internal = request.headers['x-internal-key'];
    if (config.internalApiKey && internal === config.internalApiKey) {
      return true;
    }

    const authHeader = request.headers['authorization'];
    if (!authHeader) {
      throw new UnauthorizedException('Authorization header missing');
    }
    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid authorization format');
    }

    try {
      const data = await this.supabaseService.verifyToken(String(token));
      (request as Request & { user?: unknown }).user = {
        supabaseId: data.user.id,
      };
      return true;
    } catch (err) {
      throw new UnauthorizedException(
        err instanceof Error ? err.message : 'Unauthorized',
      );
    }
  }
}

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly supabaseService: SupabaseService) {}

  // 1) marcamos canActivate como async y devolvemos Promise<boolean>
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    // 2) header obligatorio
    if (!authHeader) {
      throw new UnauthorizedException('Authorization header missing');
    }

    // 3) formateo “Bearer <token>”
    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid authorization format');
    }

    try {
      // 4) esperamos el resultado de verifyToken
      const data = await this.supabaseService.verifyToken(String(token));

      // 5) opcional: pegar el user en request para usarlo luego en el handler
      request.user = {
        supabaseId: data.user.id,
      };

      return true;
    } catch (err) {
      // recogemos cualquier fallo y lo transformamos en 401
      throw new UnauthorizedException(err.message || 'Unauthorized');
    }
  }
}

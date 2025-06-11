import { Module } from '@nestjs/common';
import { CertController } from './cert.controller';
import { CertService } from './cert.service';
import { AuthGuard } from 'src/guards/auth.guard';
import { SupabaseService } from 'src/supabase.service';

@Module({
  controllers: [CertController],
  providers: [CertService, AuthGuard, SupabaseService],
})
export class CertModule {}

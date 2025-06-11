import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CertModule } from './cert/cert.module';
import { ScrapperModule } from './scrapper/scrapper.module';
import { SupabaseService } from './supabase.service';
import { AuthGuard } from './guards/auth.guard';

@Module({
  imports: [CertModule, ScrapperModule],
  controllers: [AppController],
  providers: [AppService, SupabaseService, AuthGuard],
})
export class AppModule {}

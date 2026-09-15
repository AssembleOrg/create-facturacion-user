import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CertModule } from './cert/cert.module';
import { ScrapperModule } from './scrapper/scrapper.module';
import { SupabaseService } from './supabase.service';
import { AuthGuard } from './guards/auth.guard';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobEntity } from './job.entity';
import { AltasModule } from './altas/altas.module';
@Module({
  imports: [
    CertModule,
    ScrapperModule,
    // Alta unificada (/api/altas). Módulo aparte con su propio datasource:
    // el scrapper de arriba es el que está en producción y no se toca.
    AltasModule,
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: ':memory:',
      entities: [JobEntity],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([JobEntity]),
  ],
  controllers: [AppController],
  providers: [AppService, SupabaseService, AuthGuard],
})
export class AppModule {}

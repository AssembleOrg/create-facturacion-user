import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { dirname, isAbsolute, join } from 'path';
import { mkdirSync } from 'fs';
import { AltasController } from './altas.controller';
import { AltasService } from './altas.service';
import { AltasSupabaseService } from './altas-supabase.service';
import { AltaJobEntity } from './alta-job.entity';
import { InternalOrAuthGuard } from './internal.guard';
import { CertService } from '../cert/cert.service';
import { SupabaseService } from '../supabase.service';
import { config } from '../config/config';

/**
 * Datasource propio ('altas'), en un sqlite EN DISCO.
 *
 * El del scrapper original es `:memory:` y se queda así: una corrida masiva
 * dura horas y un restart del proceso borraba el historial entero, que es
 * justo lo que hay que reportar.
 */
const jobsDb = isAbsolute(config.jobsDb)
  ? config.jobsDb
  : join(process.cwd(), config.jobsDb);
mkdirSync(dirname(jobsDb), { recursive: true });

@Module({
  imports: [
    TypeOrmModule.forRoot({
      name: 'altas',
      type: 'sqlite',
      database: jobsDb,
      entities: [AltaJobEntity],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([AltaJobEntity], 'altas'),
  ],
  controllers: [AltasController],
  providers: [
    AltasService,
    AltasSupabaseService,
    CertService,
    SupabaseService,
    InternalOrAuthGuard,
  ],
})
export class AltasModule {}

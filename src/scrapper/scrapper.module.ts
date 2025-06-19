import { Module } from '@nestjs/common';
import { ScrapperController } from './scrapper.controller';
import { ScrapperService } from './scrapper.service';
import { CertService } from 'src/cert/cert.service';
import { SupabaseService } from 'src/supabase.service';
import { AuthGuard } from 'src/guards/auth.guard';
import { JobEntity } from 'src/job.entity';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  controllers: [ScrapperController],
  providers: [ScrapperService, CertService, SupabaseService, AuthGuard],
  imports: [TypeOrmModule.forFeature([JobEntity])],
})
export class ScrapperModule {}

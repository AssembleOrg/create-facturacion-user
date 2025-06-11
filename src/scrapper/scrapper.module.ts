import { Module } from '@nestjs/common';
import { ScrapperController } from './scrapper.controller';
import { ScrapperService } from './scrapper.service';
import { CertService } from 'src/cert/cert.service';
import { SupabaseService } from 'src/supabase.service';

@Module({
  controllers: [ScrapperController],
  providers: [ScrapperService, CertService, SupabaseService],
  imports: [],
})
export class ScrapperModule {}

import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CertModule } from './cert/cert.module';
import { ScrapperModule } from './scrapper/scrapper.module';

@Module({
  imports: [CertModule, ScrapperModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

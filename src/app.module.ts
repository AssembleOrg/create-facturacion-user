import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CertModule } from './cert/cert.module';
import { ScrapperModule } from './scrapper/scrapper.module';
import { SupabaseService } from './supabase.service';
import { AuthGuard } from './guards/auth.guard';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobEntity } from './job.entity';
@Module({
  imports: [
    CertModule,
    ScrapperModule,
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

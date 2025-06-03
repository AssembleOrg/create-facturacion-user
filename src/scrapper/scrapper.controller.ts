import { Controller, Get, Logger } from '@nestjs/common';
import { ScrapperService } from './scrapper.service';

@Controller('scrapper')
export class ScrapperController {
  private readonly logger = new Logger('ScrapperController');

  constructor(private readonly scrapperService: ScrapperService) {}

  @Get()
  async scrap() {
    this.logger.log('ScrapperController.scrap()');
    return this.scrapperService.initialize();
  }
}

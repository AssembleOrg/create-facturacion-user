import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Query,
} from '@nestjs/common';
import { ScrapperService } from './scrapper.service';
import {
  ApiBadRequestResponse,
  ApiInternalServerErrorResponse,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';

@Controller('scrapper')
export class ScrapperController {
  private readonly logger = new Logger('ScrapperController');

  constructor(private readonly scrapperService: ScrapperService) {}

  @Get()
  @ApiOperation({ summary: 'Inicializa el scrapper con credenciales' })
  @ApiQuery({
    name: 'username',
    required: true,
    description: 'Nombre de usuario para el scrapper',
  })
  @ApiBadRequestResponse({ description: 'Faltan parámetros o son inválidos' })
  @ApiInternalServerErrorResponse({
    description: 'Error al ejecutar el scrapper',
  })
  async scrap(@Query('username') username: string) {
    this.logger.log(`ScrapperController.scrap() → username=${username}`);
    if (!username) {
      throw new BadRequestException('“username”  es obligatorio');
    }
    // Pasa las credenciales al servicio:
    return await this.scrapperService.createCertificateAndPersistUser(username);
  }
}

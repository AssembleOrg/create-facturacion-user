import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ScrapperService } from './scrapper.service';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from 'src/guards/auth.guard';

@Controller('scrapper')
@UseGuards(AuthGuard)
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

  @Post()
  @ApiOperation({ summary: 'Inicializa el scrapper con credenciales' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description: 'Nombre de usuario para el scrapper',
        },
      },
      required: ['username'],
    },
  })
  @ApiBadRequestResponse({ description: 'Faltan parámetros o son inválidos' })
  @ApiInternalServerErrorResponse({
    description: 'Error al ejecutar el scrapper',
  })
  async scrapPost(@Body('username') username: string) {
    this.logger.log(`ScrapperController.scrap() → username=${username}`);
    if (!username) {
      throw new BadRequestException('“username” es obligatorio');
    }
    return await this.scrapperService.createCertificateAndPersistUser(username);
  }

  @Get('status/:id')
  @ApiOperation({ summary: 'Obtener el estado de un job' })
  @ApiParam({
    name: 'id',
    required: true,
    description: 'Identificador del job',
  })
  @ApiNotFoundResponse({ description: 'No se encontró el job' })
  @ApiInternalServerErrorResponse({
    description: 'Error al obtener el job',
  })
  async getJob(@Param('id') id: number) {
    this.logger.log(`ScrapperController.getJob() → id=${id}`);
    const job = await this.scrapperService.getJob(id);
    this.logger.log(`ScrapperController.getJob() → job=${JSON.stringify(job)}`);
    return job;
  }
}

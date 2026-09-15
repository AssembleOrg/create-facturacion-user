import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AltasService, CrearAltaDto } from './altas.service';
import { AltaJobEntity } from './alta-job.entity';
import { InternalOrAuthGuard } from './internal.guard';

/**
 * Alta unificada (certificado + relaciones de servicio + punto de venta).
 * Endpoint nuevo: `/api/altas`. El `/api/scrapper` original sigue igual.
 */
@ApiTags('altas')
@Controller('altas')
@UseGuards(InternalOrAuthGuard)
export class AltasController {
  private readonly logger = new Logger(AltasController.name);

  constructor(private readonly altas: AltasService) {}

  @Post()
  @ApiOperation({
    summary:
      'Encola el alta completa de un CUIT: certificado, relaciones de servicio (Facturación Electrónica + e-Ventanilla) y punto de venta',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['username'],
      properties: {
        username: { type: 'string', example: '20123456789' },
        realName: {
          type: 'string',
          description:
            'Nombre del contribuyente. Si se manda junto con password, se crea la fila de facturacion_users cuando falta.',
        },
        password: {
          type: 'string',
          description:
            'Clave fiscal EN CLARO (así la guarda facturacion_users)',
        },
        externalClient: { type: 'boolean' },
        opciones: {
          type: 'object',
          properties: {
            certificado: { type: 'boolean', default: true },
            relacionFe: { type: 'boolean', default: true },
            relacionWsccomu: { type: 'boolean', default: true },
            puntoVenta: { type: 'boolean', default: true },
            reusarCert: { type: 'boolean', default: true },
            headless: { type: 'boolean' },
            sistemaPuntoVenta: {
              type: 'string',
              description:
                'Fuerza el sistema del punto de venta (ej. "MAW" o "Monotributo"). Sin esto, si la condición del contribuyente no se puede deducir, el alta se corta en vez de adivinar.',
            },
          },
        },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Falta el CUIT o es inválido' })
  async crear(
    @Body() dto: CrearAltaDto,
  ): Promise<{ jobId: number; enCola: number }> {
    const cuit = (dto?.username ?? '').replace(/\D/g, '');
    if (cuit.length !== 11) {
      throw new BadRequestException(
        '“username” debe ser un CUIT de 11 dígitos',
      );
    }
    this.logger.log(`Alta encolada para ${cuit}`);
    return this.altas.crear({ ...dto, username: cuit });
  }

  @Get()
  @ApiOperation({ summary: 'Lista los jobs de alta' })
  @ApiQuery({ name: 'username', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'running', 'success', 'error'],
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listar(
    @Query('username') username?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ): Promise<AltaJobEntity[]> {
    return this.altas.listJobs({
      username,
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Estado detallado de un job de alta' })
  @ApiParam({ name: 'id', type: Number })
  async estado(@Param('id', ParseIntPipe) id: number): Promise<AltaJobEntity> {
    return this.altas.getJob(id);
  }
}

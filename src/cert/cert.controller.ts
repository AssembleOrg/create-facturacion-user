// src/cert/cert.controller.ts
import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Res,
  BadRequestException,
  Header,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBadRequestResponse,
  ApiQuery,
  ApiParam,
  ApiProduces,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { CertService } from './cert.service';

/**
 * DTO para el endpoint POST /cert/generate
 */
class GenerateDto {
  /** Common Name (CN) – obligatoria */
  commonName: string;

  /** Organization (O) – obligatoria */
  organization: string;

  /** Country (C) – ejemplo: "AR" – obligatoria */
  country: string;

  /** serialNumber (p. ej. CUIT) – obligatoria */
  serialNumber: string;
}

@ApiTags('cert')
@Controller('cert')
export class CertController {
  private readonly logger = new Logger(CertController.name);

  constructor(private readonly certService: CertService) {}

  /**
   * POST /cert/generate
   * Genera:
   *  - Un par de claves RSA (2048-bit)
   *  - Un CSR usando los campos recibidos en el body
   *
   * Request body (JSON):
   * {
   *   "commonName": "Test1",
   *   "organization": "Nombre Empresa",
   *   "country": "AR",
   *   "serialNumber": "CUIT11111111111"
   * }
   *
   * Response 200:
   * {
   *   "privateKey": "<PEM string>",
   *   "csr": "<PEM CSR string>"
   * }
   */
  @Post('generate')
  @ApiOperation({ summary: 'Genera par de claves y CSR en memoria' })
  @ApiConsumes('application/json')
  @ApiBody({
    description: 'Campos para subject del CSR',
    type: GenerateDto,
    examples: {
      example: {
        value: {
          commonName: 'Test1',
          organization: 'Nombre Empresa',
          country: 'AR',
          serialNumber: 'CUIT11111111111',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Devuelve privateKey (PEM) y csr (PEM).',
    schema: {
      type: 'object',
      properties: {
        privateKey: {
          type: 'string',
          example: '-----BEGIN PRIVATE KEY-----\n…',
        },
        csr: {
          type: 'string',
          example: '-----BEGIN CERTIFICATE REQUEST-----\n…',
        },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Faltan campos o formato inválido' })
  generate(@Body() dto: GenerateDto): { privateKey: string; csr: string } {
    const { commonName, organization, country, serialNumber } = dto;

    if (!commonName || !organization || !country || !serialNumber) {
      throw new BadRequestException(
        'commonName, organization, country y serialNumber son obligatorios.',
      );
    }

    // 1) Generar la clave
    const { privateKeyPem } = this.certService.generateKeyPair();

    // 2) Preparar subject fields para el CSR
    const subjectFields = [
      { name: 'commonName', value: commonName },
      { name: 'organizationName', value: organization },
      { name: 'countryName', value: country },
      { name: 'serialNumber', value: serialNumber },
    ];

    // 3) Generar CSR
    const csrPem = this.certService.generateCsr(privateKeyPem, subjectFields);

    const normalizedPrivateKey = privateKeyPem.replace(/\r\n/g, '\n');
    const normalizedCsr = csrPem.replace(/\r\n/g, '\n');

    this.logger.log(
      `Generated in-memory key+CSR for CN=${commonName}, SN=${serialNumber}`,
    );
    return {
      privateKey: normalizedPrivateKey,
      csr: normalizedCsr,
    };
  }

  /**
   * GET /cert/download/:type
   *
   * :type = 'key' o 'csr'
   * - Si 'key', genera un par de claves y envía la clave privada como descarga (.pem).
   * - Si 'csr', genera un par de claves y CSR, y envía el CSR como descarga (.pem).
   *
   * Ejemplos:
   *   GET /cert/download/key?commonName=Test1&organization=OrgX&country=AR&serialNumber=CUIT123
   *   GET /cert/download/csr?commonName=Test1&organization=OrgX&country=AR&serialNumber=CUIT123
   */
  @Get('download/:type')
  @ApiOperation({
    summary:
      'Descarga dinámica de clave privada (type=key) o CSR (type=csr) en PEM',
  })
  @ApiParam({
    name: 'type',
    enum: ['key', 'csr'],
    description: 'Tipo de archivo a descargar: key o csr',
  })
  @ApiQuery({
    name: 'commonName',
    required: true,
    description: 'Common Name (CN) para el CSR',
    example: 'Test1',
  })
  @ApiQuery({
    name: 'organization',
    required: true,
    description: 'Organization (O) para el CSR',
    example: 'Nombre Empresa',
  })
  @ApiQuery({
    name: 'country',
    required: true,
    description: 'Country (C), ej. AR',
    example: 'AR',
  })
  @ApiQuery({
    name: 'serialNumber',
    required: true,
    description: 'serialNumber (ej. CUIT)',
    example: 'CUIT11111111111',
  })
  @ApiProduces('application/x-pem-file', 'application/pkcs10')
  @Header('Cache-Control', 'no-store') // Para que no cachée el PEM
  @ApiResponse({
    status: 200,
    description: 'El PEM descargado como attachment',
  })
  @ApiBadRequestResponse({ description: 'Faltan parámetros o type inválido' })
  download(
    @Param('type') type: 'key' | 'csr',
    @Body() _unusedBody: any,
    @Res() res: Response,
    // Los campos vienen por query, pero Nest no los mapea automáticamente en GET+Param
    // así que extraemos desde res.req.query:
  ): void | Response<any, Record<string, any>> {
    // Parseamos los parámetros de la URL manualmente:
    const query = res.req.query as {
      commonName?: string;
      organization?: string;
      country?: string;
      serialNumber?: string;
    };

    const { commonName, organization, country, serialNumber } = query;

    if (!commonName || !organization || !country || !serialNumber) {
      throw new BadRequestException(
        'Query params missing: commonName, organization, country, serialNumber',
      );
    }

    // 1) Generar par de claves (siempre lo hacemos, aunque si type === 'key' no usaremos la pública)
    const { privateKeyPem } = this.certService.generateKeyPair();

    // Si quieren devolver sólo la key:
    if (type === 'key') {
      const filename = `${commonName.replace(/\s+/g, '_')}-key.pem`;
      res.set({
        'Content-Type': 'application/x-pem-file',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      return res.send(privateKeyPem);
    }

    // Si quieren devolver el CSR:
    if (type === 'csr') {
      // Generar CSR con el mismo privateKeyPem
      const subjectFields = [
        { name: 'commonName', value: commonName },
        { name: 'organizationName', value: organization },
        { name: 'countryName', value: country },
        { name: 'serialNumber', value: serialNumber },
      ];
      const csrPem = this.certService.generateCsr(privateKeyPem, subjectFields);
      const filename = `${commonName.replace(/\s+/g, '_')}-csr.pem`;
      res.set({
        'Content-Type': 'application/pkcs10',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      return res.send(csrPem);
    }

    // Si llegan aquí, type no era válido
    throw new BadRequestException('type inválido. Use "key" o "csr".');
  }
}

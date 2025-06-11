// src/cert/dto/get-certificate-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class GetCertificateResponseDto {
  @ApiProperty({ description: 'Clave privada en formato PEM' })
  key: string;

  @ApiProperty({ description: 'Certificado público en formato PEM' })
  cert: string;
}

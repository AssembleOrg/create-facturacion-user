import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class LoadCertificateDto {
  @ApiProperty({ description: 'ID del usuario (string)' })
  @IsNotEmpty()
  @IsString()
  userId: string;

  @ApiProperty({ description: 'Clave privada en formato PEM' })
  @IsNotEmpty()
  @IsString()
  key: string;

  @ApiProperty({ description: 'Certificado público en formato PEM' })
  @IsNotEmpty()
  @IsString()
  cert: string;
}

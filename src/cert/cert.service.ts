// src/cert/cert.service.ts
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as forge from 'node-forge';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config } from 'src/config/config';
import Vault from 'node-vault';

export interface PemPair {
  privateKey: string; // "-----BEGIN PRIVATE KEY-----\n…"
  csr: string; // "-----BEGIN CERTIFICATE REQUEST-----\n…"
}

/**
 * CertService:
 * - Genera pares de claves RSA (2048 bits).
 * - Genera CSRs (Certificate Signing Requests) a partir de la clave privada y campos dinámicos.
 */
@Injectable()
export class CertService {
  private readonly logger = new Logger(CertService.name);
  private VAULT_ADDRESS = config.vaultAddress;
  private VAULT_TOKEN = config.vaultToken;
  private VAULT_CLIENT: Vault.client;
  constructor() {
    this.VAULT_CLIENT = Vault({
      apiVersion: 'v1',
      endpoint: this.VAULT_ADDRESS,
      token: this.VAULT_TOKEN,
    });
  }

  /**
   * Genera un par de claves RSA de 2048 bits en formato PEM.
   */
  generateKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
    // 1) Generar la key pair RSA
    const keypair = forge.pki.rsa.generateKeyPair(2048);

    // 2) Convertir a PEM
    const privateKeyPem = forge.pki.privateKeyToPem(keypair.privateKey);
    const publicKeyPem = forge.pki.publicKeyToPem(keypair.publicKey);

    this.logger.log('Generated new RSA key pair');
    return { privateKeyPem, publicKeyPem };
  }

  /**
   * Genera un CSR (Certificate Signing Request) en PEM.
   *
   * @param privateKeyPem La clave privada en PEM (string).
   * @param subjectFields Array de objetos { name, value } para el subject del CSR.
   *                      Ej: [{ name: 'commonName', value: 'Test1' }, ...]
   */
  generateCsr(
    privateKeyPem: string,
    subjectFields: Array<{ name: string; value: string }>,
  ): string {
    // 1) Parsear la clave privada desde PEM
    const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);

    // 2) Crear objeto CertificationRequest
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);

    // 3) Asignar subject fields
    csr.setSubject(subjectFields);

    // 4) Firmar el CSR con SHA-256
    csr.sign(privateKey, forge.md.sha256.create());

    // 5) Verificar el CSR
    if (!csr.verify()) {
      this.logger.error('CSR verification failed');
      throw new Error('CSR verification failed');
    }

    // 6) Convertir CSR a PEM
    const pemCsr = forge.pki.certificationRequestToPem(csr);
    this.logger.log('Generated CSR successfully');
    return pemCsr;
  }

  public writePemFiles(
    data: PemPair,
    baseName: string,
  ): { keyPath: string; csrPath: string } {
    // 1) Creamos una carpeta temporal única: /tmp/certs/<timestamp>/
    const timestamp = Date.now();
    const tmpDir = path.join(os.tmpdir(), 'certs', String(timestamp));
    fs.mkdirSync(tmpDir, { recursive: true });

    // 2) Definimos los nombres de los archivos
    const keyFilename = `${baseName}-key.pem`;
    const csrFilename = `${baseName}-csr.pem`;

    const keyPath = path.join(tmpDir, keyFilename);
    const csrPath = path.join(tmpDir, csrFilename);

    // 3) Escribimos cada string en su archivo.
    //    Asegúrate de que el string ya viene con '\n', no con '\r\n', para evitar duplicar líneas.
    fs.writeFileSync(keyPath, data.privateKey, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.writeFileSync(csrPath, data.csr, { encoding: 'utf8', mode: 0o644 });

    this.logger.log(`Wrote private key to ${keyPath}`);
    this.logger.log(`Wrote CSR to         ${csrPath}`);

    return { keyPath, csrPath };
  }

  /**
   * Graba la clave y certificado del usuario en Vault
   */
  async loadUserCertificateAndKey(
    userId: string,
    key: string,
    cert: string,
  ): Promise<void> {
    try {
      const path = `secret/data/certificate/${userId}`;
      await this.VAULT_CLIENT.write(path, {
        data: { key, cert },
      });
    } catch (error: any) {
      // Puedes personalizar el mensaje según el error que devuelva Vault
      throw new InternalServerErrorException(
        `Error escribiendo en Vault: ${error.message}`,
      );
    }
  }

  /**
   * Lee la clave y certificado del usuario desde Vault
   */
  async getUserCertificateAndKey(
    userId: string,
  ): Promise<{ key: string; cert: string }> {
    try {
      const path = `secret/data/certificate/${userId}`;
      const result = await this.VAULT_CLIENT.read(path);

      // En Vault KV v2, los datos suelen estar en result.data.data
      if (!result || !result.data || !result.data.data) {
        throw new NotFoundException('Certificado no encontrado');
      }
      this.logger.log('Resultado de getUserCertificateAndKey', result);
      const data = result.data.data as { key: string; cert: string };
      return data;
    } catch (err: any) {
      if (err.response && err.response.statusCode === 404) {
        // Si Vault devuelve 404 en su API
        throw new NotFoundException('Certificado no encontrado');
      }
      throw new InternalServerErrorException(
        `Error leyendo de Vault: ${err.message}`,
      );
    }
  }
}

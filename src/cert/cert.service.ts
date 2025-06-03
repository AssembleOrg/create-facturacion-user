// src/cert/cert.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as forge from 'node-forge';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
}

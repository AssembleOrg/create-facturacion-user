/**
 * Runner secuencial: por cada CUIT genera key+CSR fresco en static/uploads,
 * corre el scrapper (cert + relación Facturación Electrónica + punto de venta),
 * verifica que el cert quedó en Vault y anota el resultado en batch-results.json.
 * Browser headful, un usuario por vez. Los usuarios deben existir en
 * facturacion_users (ver estudio-backend/scripts/prepare-facturacion-users.cjs).
 *
 * Uso:
 *   npx ts-node -r tsconfig-paths/register run-batch.ts 20xxxxxxxxx [27xxxxxxxxx ...]
 * Env opcionales:
 *   HEADLESS        default 'false' acá (browser visible); el servidor usa true
 *   HUMAN_WAIT_MS   espera máxima por intervención humana ante captcha (default 180000)
 *   PAUSE_MS        pausa entre usuarios (default 15000)
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AppModule } from './src/app.module';
import { ScrapperService } from './src/scrapper/scrapper.service';
import { CertService } from './src/cert/cert.service';
import { SupabaseService } from './src/supabase.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RESULTS = join(process.cwd(), 'batch-results.json');

type Result = {
  cuit: string;
  fuId?: number;
  nombre?: string;
  status: string;
  error?: string;
  salePoint?: number | null;
  vault?: boolean;
  rescued?: boolean;
  at: string;
};

function loadResults(): Result[] {
  if (!existsSync(RESULTS)) return [];
  try {
    return JSON.parse(readFileSync(RESULTS, 'utf8'));
  } catch {
    return [];
  }
}
function saveResult(r: Result) {
  const all = loadResults();
  all.push(r);
  writeFileSync(RESULTS, JSON.stringify(all, null, 2));
}

function writeFreshCsr(cert: CertService, cuit: string, nombre: string) {
  const uploads = join(process.cwd(), 'static', 'uploads');
  rmSync(uploads, { recursive: true, force: true });
  mkdirSync(uploads, { recursive: true });
  const { privateKeyPem } = cert.generateKeyPair();
  const csr = cert.generateCsr(privateKeyPem, [
    { name: 'commonName', value: 'Facturacion1' },
    { name: 'organizationName', value: nombre || cuit },
    { name: 'countryName', value: 'AR' },
    { name: 'serialNumber', value: `CUIT ${cuit}` },
  ]);
  writeFileSync(join(uploads, 'csr-creado.pem'), csr.replace(/\r\n/g, '\n'), 'utf8');
  writeFileSync(join(uploads, 'key-creado.pem'), privateKeyPem.replace(/\r\n/g, '\n'), { encoding: 'utf8', mode: 0o600 });
}

async function main() {
  const log = new Logger('run-batch');
  const cuits = process.argv.slice(2).map((c) => c.replace(/\D/g, '')).filter((c) => /^\d{11}$/.test(c));
  if (cuits.length === 0) {
    log.error('Uso: run-batch.ts <cuit> [cuit...]');
    process.exit(1);
  }
  const pauseMs = Number(process.env.PAUSE_MS || 15_000);
  process.env.HEADLESS ??= 'false';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });
  const scrapper = app.get(ScrapperService);
  const cert = app.get(CertService);
  const supabase = app.get(SupabaseService);

  for (let i = 0; i < cuits.length; i++) {
    const cuit = cuits[i];
    log.log(`\n===== [${i + 1}/${cuits.length}] CUIT ${cuit} =====`);
    const r: Result = { cuit, status: 'pending', at: new Date().toISOString() };
    try {
      const user = await supabase.getFacturacionUser(cuit);
      if (!user) throw new Error('No existe en facturacion_users (correr prepare-facturacion-users primero)');
      if (!user.password) throw new Error('facturacion_users sin password');
      r.fuId = Number(user.id);
      r.nombre = user.real_name ?? undefined;
      log.log(`${user.real_name} (fu ${user.id}) salePoint actual=${user.salePoint ?? '-'}`);

      writeFreshCsr(cert, cuit, user.real_name ?? '');
      log.log('Key + CSR frescos escritos en static/uploads');

      const { jobId } = await scrapper.createCertificateAndPersistUser(cuit);
      const deadline = Date.now() + 15 * 60 * 1000;
      let status = 'pending';
      let error: string | undefined;
      while (Date.now() < deadline) {
        await sleep(4000);
        const job = await scrapper.getJob(jobId);
        status = job.status;
        error = job.error;
        if (status !== 'pending') break;
      }
      r.status = status;
      r.error = error;

      // Verificación post: Vault + salePoint
      try {
        const { cert: c, key } = await cert.getUserCertificateAndKey(String(user.id));
        r.vault = !!(c && key);
      } catch {
        r.vault = false;
      }

      // Si falló después de descargar el cert (típico: punto de venta), el
      // .crt queda en static/downloads y la key en static/uploads. Se rescatan
      // a rescued/<cuit>/ y se suben a Vault antes de que el próximo usuario
      // pise los directorios.
      if (status !== 'success' && !r.vault) {
        const dl = join(process.cwd(), 'static', 'downloads');
        const crt = existsSync(dl) ? readdirSync(dl).find((f) => f.endsWith('.crt')) : undefined;
        const keyPath = join(process.cwd(), 'static', 'uploads', 'key-creado.pem');
        if (crt && existsSync(keyPath)) {
          const dir = join(process.cwd(), 'rescued', cuit);
          mkdirSync(dir, { recursive: true });
          const certPem = readFileSync(join(dl, crt), 'utf8');
          const keyPem = readFileSync(keyPath, 'utf8');
          writeFileSync(join(dir, 'cert.crt'), certPem);
          writeFileSync(join(dir, 'key.pem'), keyPem, { mode: 0o600 });
          try {
            await cert.loadUserCertificateAndKey(String(user.id), keyPem, certPem);
            r.vault = true;
            r.rescued = true;
            log.warn(`Cert rescatado y subido a Vault certificate/${user.id} (falta salePoint / relación según dónde falló)`);
          } catch (e: any) {
            log.error(`No se pudo subir cert rescatado a Vault: ${e?.message}`);
          }
        }
      }
      const after = await supabase.getFacturacionUser(cuit);
      r.salePoint = after?.salePoint ?? null;
      log.log(`>>> ${cuit} ${user.real_name}: ${status}${error ? ' — ' + error : ''} | vault=${r.vault} salePoint=${r.salePoint}`);
    } catch (e: any) {
      r.status = 'throw';
      r.error = e?.message;
      log.error(`>>> ${cuit}: EXCEPTION ${e?.message}`);
    }
    saveResult(r);
    if (i < cuits.length - 1) {
      log.log(`Pausa ${pauseMs / 1000}s antes del siguiente...`);
      await sleep(pauseMs);
    }
  }

  log.log('\n============ RESUMEN ============');
  const mine = loadResults().filter((x) => cuits.includes(x.cuit)).slice(-cuits.length);
  for (const x of mine) log.log(`${x.cuit} ${x.nombre ?? ''} | ${x.status} | vault=${x.vault} sp=${x.salePoint}${x.error ? ' | ' + x.error : ''}`);
  await app.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

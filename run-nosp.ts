/**
 * Runner secuencial para crear cert + punto de venta de los usuarios SIN salePoint.
 * Usa el AppModule de Nest (mismo scrapper). Un browser por vez (headful).
 *
 * Uso:
 *   npx ts-node -r tsconfig-paths/register run-nosp.ts                 # los 10 default
 *   npx ts-node -r tsconfig-paths/register run-nosp.ts 20965162845 ...  # CUITs sueltos
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './src/app.module';
import { ScrapperService } from './src/scrapper/scrapper.service';

// 10 users sin salePoint (supabase facturacion_users, 2026-08-29)
const DEFAULT_CUITS = [
  '20965162845', // 179 LOPEZ AVILA YANE ROSALBA
  '20952347749', // 184 RODRIGUEZ RAMIREZ JOSE NELSON
  '20280342204', // 185 SIMONDEGUI PABLO EZEQUIEL
  '20281788680', // 186 ALONSO HERNAN RAFAEL
  '27316589257', // 187 FERNANDEZ AGNELLO VALERIA
  '27965344352', // 188 GOMEZ MONTALVO EDUARDO LUIS
  '20950918765', // 189 GARCIA MENDEZ JONH JAIRO
  '20949713092', // 190 OLASCOAGA ZUÑIGA CRISTIAN ROBIN
  '20964255068', // 191 CUBERO CARPIO DANNY DAMIAN
  '27351618677', // 192 MENDEZ RIGHI DANIELA
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const log = new Logger('run-nosp');
  const cuits = process.argv.slice(2).filter(Boolean);
  const targets = cuits.length > 0 ? cuits : DEFAULT_CUITS;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });
  const scrapper = app.get(ScrapperService);

  const results: Array<{ cuit: string; status: string; error?: string }> = [];

  for (let i = 0; i < targets.length; i++) {
    const cuit = targets[i];
    log.log(`\n===== [${i + 1}/${targets.length}] CUIT ${cuit} =====`);
    try {
      const { jobId } = await scrapper.createCertificateAndPersistUser(cuit);

      // Poll hasta terminar (máx 10 min por usuario)
      const deadline = Date.now() + 10 * 60 * 1000;
      let status = 'pending';
      let error: string | undefined;
      while (Date.now() < deadline) {
        await sleep(4000);
        const job = await scrapper.getJob(jobId);
        status = job.status;
        error = job.error;
        if (status !== 'pending') break;
      }
      results.push({ cuit, status, error });
      log.log(`>>> CUIT ${cuit}: ${status}${error ? ' — ' + error : ''}`);
    } catch (e: any) {
      results.push({ cuit, status: 'throw', error: e?.message });
      log.error(`>>> CUIT ${cuit}: EXCEPTION ${e?.message}`);
    }
  }

  log.log('\n============ RESUMEN ============');
  for (const r of results) {
    log.log(`${r.cuit} | ${r.status}${r.error ? ' | ' + r.error : ''}`);
  }
  const ok = results.filter((r) => r.status === 'success').length;
  log.log(`OK: ${ok}/${results.length}`);

  await app.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

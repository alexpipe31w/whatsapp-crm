/**
 * Aplica las migraciones a la BD de tests. Fija DATABASE_URL ANTES de lanzar
 * Prisma para que nunca use la del .env (producción o túnel).
 */
import { spawnSync } from 'node:child_process';
import { assertLocalDatabase, assertTestDatabaseName } from '../test/support/guard';
import { TEST_DATABASE_URL } from '../test/support/env';

const url = assertLocalDatabase('TEST_DATABASE_URL', TEST_DATABASE_URL);
assertTestDatabaseName(new URL(url).pathname.slice(1));

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);

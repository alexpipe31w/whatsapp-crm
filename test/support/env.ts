// URL de la BD de tests. Puerto 5434 = Postgres de WSL. NUNCA 5433 (túnel a producción).
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://crm_test:crm_test@localhost:5434/crm_test';

export const TEST_SHADOW_DATABASE_URL =
  process.env.TEST_SHADOW_DATABASE_URL ??
  'postgresql://crm_test:crm_test@localhost:5434/crm_shadow_test';

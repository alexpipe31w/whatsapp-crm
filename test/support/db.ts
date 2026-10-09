import { PrismaService } from '../../src/prisma/prisma.service';
import { assertLocalDatabase, assertTestDatabaseName } from './guard';

let client: PrismaService | null = null;

/** Cliente Prisma de los tests (mismo PrismaService que usa la app). */
export function testPrisma(): PrismaService {
  if (!client) {
    assertLocalDatabase('DATABASE_URL', process.env.DATABASE_URL);
    client = new PrismaService();
  }
  return client;
}

/** Vacía todas las tablas. Se niega a correr fuera de localhost o de una BD *_test. */
export async function resetDb(): Promise<void> {
  const prisma = testPrisma();
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  assertTestDatabaseName(db);

  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

export async function closeTestPrisma(): Promise<void> {
  if (client) await client.onModuleDestroy(); // también cierra el pool de pg
  client = null;
}

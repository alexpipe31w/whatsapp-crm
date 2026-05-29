import { PrismaClient } from '../src/generated/prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.subscriptionConfig.upsert({
    where: { configId: 'singleton' },
    create: { configId: 'singleton', priceAmount: 24000, currency: 'COP' },
    update: { priceAmount: 24000, currency: 'COP' },
  });
  console.log('✅ SubscriptionConfig inicializado: $24.000 COP/mes');
}

main().catch(console.error).finally(() => prisma.$disconnect());

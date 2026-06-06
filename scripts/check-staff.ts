import { PrismaClient } from '../src/generated/prisma/client';
import * as dotenv from 'dotenv';
dotenv.config();

const prisma = new PrismaClient();

async function main() {
  const staff = await prisma.staff.findMany({
    where: { storeId: '039e81b7-28a1-48e5-9cca-95b0d0204f92' },
  });
  staff.forEach(s => {
    console.log(`\n=== ${s.name} (isActive: ${s.isActive}) ===`);
    console.log(JSON.stringify(s.schedule, null, 2));
  });
}

main().finally(() => prisma.$disconnect());

// @ts-ignore
import { PrismaClient } from '../src/generated/prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const email = 'alexpipe31w@gmail.com';
  const hashed = await bcrypt.hash('Palomino112..', 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: { password: hashed, role: 'superadmin', isActive: true, name: 'Alex Superadmin' },
    create: { name: 'Alex Superadmin', email, password: hashed, role: 'superadmin', isActive: true },
  });

  console.log(`✅ Superadmin listo: ${user.email} (role: ${user.role})`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

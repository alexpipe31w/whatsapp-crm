/**
 * Limpia datos de prueba SOLO del store de desarrollo.
 * Conserva: servicios, productos, staff, store, AI config, categorías.
 */
import { PrismaClient } from '../src/generated/prisma/client';

const prisma = new PrismaClient();
const STORE_ID = '039e81b7-28a1-48e5-9cca-95b0d0204f92';

async function main() {
  console.log(`🧹 Limpiando datos de prueba del store ${STORE_ID}...\n`);

  const timelines = await prisma.appointmentTimeline.deleteMany({
    where: { appointment: { storeId: STORE_ID } },
  });
  console.log(`✅ AppointmentTimelines: ${timelines.count}`);

  const citas = await prisma.appointment.deleteMany({ where: { storeId: STORE_ID } });
  console.log(`✅ Citas: ${citas.count}`);

  const msgs = await prisma.message.deleteMany({
    where: { conversation: { storeId: STORE_ID } },
  });
  console.log(`✅ Mensajes: ${msgs.count}`);

  const convs = await prisma.conversation.deleteMany({ where: { storeId: STORE_ID } });
  console.log(`✅ Conversaciones: ${convs.count}`);

  const orderItems = await prisma.orderItem.deleteMany({
    where: { order: { storeId: STORE_ID } },
  });
  console.log(`✅ OrderItems: ${orderItems.count}`);

  const orders = await prisma.order.deleteMany({ where: { storeId: STORE_ID } });
  console.log(`✅ Órdenes: ${orders.count}`);

  const customers = await prisma.customer.deleteMany({ where: { storeId: STORE_ID } });
  console.log(`✅ Clientes: ${customers.count}`);

  console.log('\n🎉 Listo. Solo el store de prueba fue limpiado.');
  console.log('   Conservado: servicios, productos, staff, configuración AI.');
}

main()
  .catch(e => { console.error('❌ Error:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());

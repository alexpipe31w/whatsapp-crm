import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getDashboard(storeId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalClientes,
      nuevosHoy,
      conversaciones,
      mensajes,
      ordenes,
      campanas,
      conversacionesRecientes,
    ] = await Promise.all([

      // Clientes totales
      this.prisma.customer.count({ where: { storeId } }),

      // Clientes nuevos hoy
      this.prisma.customer.count({
        where: { storeId, createdAt: { gte: today } },
      }),

      // Conversaciones por estado
      this.prisma.conversation.groupBy({
        by: ['status'],
        where: { storeId },
        _count: { status: true },
      }),

      // Mensajes totales / por IA / por humano
      this.prisma.message.aggregate({
        where: { storeId },
        _count: { messageId: true },
      }).then(async (total) => {
        const porIA = await this.prisma.message.count({
          where: { storeId, isAiResponse: true },
        });
        return {
          total: total._count.messageId,
          porIA,
          porHumano: total._count.messageId - porIA,
        };
      }),

      // Órdenes por estado + revenue
      this.prisma.order.groupBy({
        by: ['status'],
        where: { storeId },
        _count: { status: true },
        _sum: { total: true },
      }),

      // Campañas
      this.prisma.campaign.aggregate({
        where: { storeId },
        _count: { campaignId: true },
      }).then(async (total) => {
        const enviadas = await this.prisma.campaign.count({
          where: { storeId, status: 'sent' },
        });
        return { total: total._count.campaignId, enviadas };
      }),

      // Conversaciones recientes con último mensaje
      this.prisma.conversation.findMany({
        where: { storeId },
        orderBy: { lastMessageAt: 'desc' },
        take: 10,
        include: {
          customer: true,
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      }),
    ]);

    // Procesar conversaciones por estado
    const convMap: Record<string, number> = {};
    conversaciones.forEach((c) => { convMap[c.status] = c._count.status; });

    // Procesar órdenes por estado
    const orderMap: Record<string, number> = {};
    let revenueTotal = 0;
    ordenes.forEach((o) => {
      orderMap[o.status] = o._count.status;
      if (o.status === 'delivered') {
        revenueTotal += Number(o._sum.total ?? 0);
      }
    });

    return {
      clientes: {
        total: totalClientes,
        nuevosHoy,
      },
      conversaciones: {
        total: Object.values(convMap).reduce((a, b) => a + b, 0),
        activas:           convMap['active']        ?? 0,
        esperandoHumano:   convMap['pending_human'] ?? 0,
        conAsesor:         convMap['human']         ?? 0,
        cerradas:          convMap['closed']        ?? 0,
      },
      mensajes,
      ordenes: {
        total:       Object.values(orderMap).reduce((a, b) => a + b, 0),
        pendientes:  orderMap['pending']   ?? 0,
        confirmadas: orderMap['confirmed'] ?? 0,
        preparando:  orderMap['preparing'] ?? 0,
        listas:      orderMap['ready']     ?? 0,
        entregadas:  orderMap['delivered'] ?? 0,
        canceladas:  orderMap['cancelled'] ?? 0,
        revenueTotal,
      },
      campanas,
      conversacionesRecientes,
    };
  }
}
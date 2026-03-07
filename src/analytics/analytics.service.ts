import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async getDashboard(storeId: string) {
    const [
      totalCustomers,
      newCustomersToday,
      totalConversations,
      activeConversations,
      pendingHumanConversations,
      closedConversations,
      totalMessages,
      aiMessages,
      humanMessages,
      totalOrders,
      pendingOrders,
      confirmedOrders,
      deliveredOrders,
      cancelledOrders,
      totalProducts,
      totalCampaigns,
      sentCampaigns,
      recentConversations,
    ] = await Promise.all([
      // Clientes
      this.prisma.customer.count({ where: { storeId } }),
      this.prisma.customer.count({
        where: {
          storeId,
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
      // Conversaciones
      this.prisma.conversation.count({ where: { storeId } }),
      this.prisma.conversation.count({ where: { storeId, status: 'active' } }),
      this.prisma.conversation.count({ where: { storeId, status: 'pending_human' } }),
      this.prisma.conversation.count({ where: { storeId, status: 'closed' } }),
      // Mensajes
      this.prisma.message.count({ where: { storeId } }),
      this.prisma.message.count({ where: { storeId, isAiResponse: true } }),
      this.prisma.message.count({ where: { storeId, isAiResponse: false } }),
      // Órdenes
      this.prisma.order.count({ where: { storeId } }),
      this.prisma.order.count({ where: { storeId, status: 'pending' } }),
      this.prisma.order.count({ where: { storeId, status: 'confirmed' } }),
      this.prisma.order.count({ where: { storeId, status: 'delivered' } }),
      this.prisma.order.count({ where: { storeId, status: 'cancelled' } }),
      // Productos y campañas
      this.prisma.product.count({ where: { storeId, isActive: true } }),
      this.prisma.campaign.count({ where: { storeId } }),
      this.prisma.campaign.count({ where: { storeId, status: 'sent' } }),
      // Conversaciones recientes con último mensaje
      this.prisma.conversation.findMany({
        where: { storeId },
        include: {
          customer: true,
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { lastMessageAt: 'desc' },
        take: 10,
      }),
    ]);

    // Revenue
    const revenueResult = await this.prisma.order.aggregate({
      where: { storeId, status: { not: 'cancelled' } },
      _sum: { total: true },
    });

    const revenueDelivered = await this.prisma.order.aggregate({
      where: { storeId, status: 'delivered' },
      _sum: { total: true },
    });

    return {
      clientes: {
        total: totalCustomers,
        nuevosHoy: newCustomersToday,
      },
      conversaciones: {
        total: totalConversations,
        activas: activeConversations,
        esperandoHumano: pendingHumanConversations,
        cerradas: closedConversations,
      },
      mensajes: {
        total: totalMessages,
        porIA: aiMessages,
        porHumano: humanMessages,
      },
      ordenes: {
        total: totalOrders,
        pendientes: pendingOrders,
        confirmadas: confirmedOrders,
        entregadas: deliveredOrders,
        canceladas: cancelledOrders,
        revenueTotal: revenueResult._sum.total ?? 0,
        revenueEntregado: revenueDelivered._sum.total ?? 0,
      },
      productos: { activos: totalProducts },
      campanas: { total: totalCampaigns, enviadas: sentCampaigns },
      conversacionesRecientes: recentConversations,
    };
  }
}

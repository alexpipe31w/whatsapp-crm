import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validate } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { StoresModule } from './stores/stores.module';
import { CustomersModule } from './customers/customers.module';
import { ConversationsModule } from './conversations/conversations.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ProductsModule } from './products/products.module';
import { ServicesModule } from './services/services.module';
import { OrdersModule } from './orders/orders.module';
import { MessagesModule } from './messages/messages.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { AiModule } from './ai/ai.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { BlockedModule } from './blocked/blocked.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),
    PrismaModule,
    StoresModule,
    CustomersModule,
    ConversationsModule,
    DashboardModule,
    ProductsModule,
    ServicesModule,
    OrdersModule,
    MessagesModule,
    CampaignsModule,
    WhatsappModule,
    AiModule,
    AnalyticsModule,
    AuthModule,
    BlockedModule,
  ],
})
export class AppModule {}
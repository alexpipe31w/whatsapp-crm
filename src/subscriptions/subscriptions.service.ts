import {
  Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import * as crypto from 'crypto';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private mpClient: MercadoPagoConfig;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    this.mpClient = new MercadoPagoConfig({
      accessToken: this.config.get<string>('MP_ACCESS_TOKEN') ?? '',
    });
  }

  // ─── Checkout ─────────────────────────────────────────────────────────────

  async checkout(storeId: string): Promise<{ initPoint: string }> {
    if (!storeId) throw new BadRequestException('Tienda no encontrada en la sesión');

    const store = await this.prisma.store.findUnique({ where: { storeId } });
    if (!store) throw new NotFoundException('Tienda no encontrada');

    const subConfig = await this.prisma.subscriptionConfig.findUnique({
      where: { configId: 'singleton' },
    });
    const price    = subConfig ? Number(subConfig.priceAmount) : 24000;
    const currency = subConfig?.currency ?? 'COP';

    const frontendUrl        = this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';
    const backendUrl         = this.config.get<string>('APP_URL')      ?? 'http://localhost:3001';
    const isBackendLocalhost = backendUrl.includes('localhost');
    // MP Colombia usa APP_USR- incluso en credenciales de prueba — usar MP_SANDBOX=true para forzar sandbox
    const isSandbox = this.config.get<string>('MP_SANDBOX') === 'true'
      || (this.config.get<string>('MP_ACCESS_TOKEN') ?? '').startsWith('TEST-');

    const prefClient = new Preference(this.mpClient);

    const result = await prefClient.create({
      body: {
        items: [{
          id:         'stockup-mensajes-plan',
          title:      'Stockup Mensajes — Plan Mensual',
          quantity:   1,
          unit_price: price,
          currency_id: currency,
        }],
        external_reference: storeId,
        back_urls: {
          success: `${frontendUrl}/payment-status?status=success`,
          failure: `${frontendUrl}/payment-status?status=failure`,
          pending: `${frontendUrl}/payment-status?status=pending`,
        },
        // auto_return solo con HTTPS — en localhost MP lo rechaza
        ...(frontendUrl.startsWith('https') && { auto_return: 'approved' as const }),
        // notification_url solo cuando el backend es accesible públicamente
        ...(!isBackendLocalhost && {
          notification_url: `${backendUrl}/api/subscriptions/webhook`,
        }),
        expiration_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      // Incluye minuto para evitar cacheo de preferencias del mismo día
      requestOptions: {
        idempotencyKey: `checkout-${storeId}-${new Date().toISOString().slice(0, 16)}-v7`,
      },
    });

    // Registrar intento de pago
    await this.prisma.subscription.upsert({
      where:  { storeId },
      create: { storeId, status: 'pending', priceAmount: price },
      update: { status: 'pending', priceAmount: price, updatedAt: new Date() },
    });

    const initPoint = isSandbox
      ? (result.sandbox_init_point ?? result.init_point!)
      : result.init_point!;

    this.logger.log(
      `Checkout | store=${storeId} price=${price} sandbox=${isSandbox} backendLocal=${isBackendLocalhost}`,
    );
    return { initPoint };
  }

  // ─── Webhook ──────────────────────────────────────────────────────────────

  async handleWebhook(
    body:    any,
    query:   Record<string, string>,
    headers: Record<string, string>,
  ): Promise<void> {
    // Retorno inmediato — MP necesita 200 en < 5s.
    // El procesamiento real corre en background (fire-and-forget).
    this.doProcessWebhook(body, query, headers).catch(err =>
      this.logger.error(`Error background webhook: ${err.message}`),
    );
  }

  private async doProcessWebhook(
    body:    any,
    query:   Record<string, string>,
    headers: Record<string, string>,
  ): Promise<void> {
    this.logger.log(`Webhook | type=${body?.type} action=${body?.action} data.id=${body?.data?.id}`);

    // Ignorar merchant_order — MP los envía junto con pagos, no son pagos
    if (body?.topic === 'merchant_order' || body?.type === 'merchant_order') return;

    // Solo procesar notificaciones de pago
    const isPaymentEvent =
      body?.type   === 'payment' ||
      body?.action === 'payment.created' ||
      body?.action === 'payment.updated';
    if (!isPaymentEvent) return;

    // Verificar firma HMAC si está configurada
    if (!this.verifySignature(headers, query)) {
      this.logger.warn('Webhook rechazado: firma HMAC inválida');
      return;
    }

    const paymentId = this.extractPaymentId(body, query);
    if (!paymentId) {
      this.logger.warn('Webhook sin paymentId válido');
      return;
    }

    try {
      const result = await this.processPaymentById(paymentId);
      this.logger.log(`Webhook procesado | paymentId=${paymentId} status=${result.status}`);
    } catch (err: any) {
      this.logger.error(`Webhook error | paymentId=${paymentId}: ${err.message}`);
    }
  }

  // ─── Verificación HMAC de firma de MP ─────────────────────────────────────
  // Documentación: https://www.mercadopago.com.co/developers/es/docs/your-integrations/notifications/webhooks

  private verifySignature(
    headers: Record<string, string>,
    query:   Record<string, string>,
  ): boolean {
    const secret  = this.config.get<string>('MP_WEBHOOK_SECRET');
    const isProd  = this.config.get<string>('NODE_ENV') === 'production';
    if (!secret) {
      if (isProd) {
        // En producción es obligatorio tener el secret para prevenir webhooks falsos
        this.logger.error('MP_WEBHOOK_SECRET no configurado en producción — webhook rechazado por seguridad');
        return false;
      }
      this.logger.debug('MP_WEBHOOK_SECRET no configurado — saltando verificación de firma (solo dev)');
      return true;
    }

    const xSignature = headers['x-signature'];
    const xRequestId = headers['x-request-id'];
    if (!xSignature) return true; // MP sandbox no siempre envía firma

    const ts = xSignature.split(',').find(p => p.startsWith('ts='))?.slice(3);
    const v1 = xSignature.split(',').find(p => p.startsWith('v1='))?.slice(3);
    if (!ts || !v1) return false;

    const dataId   = query['data.id'] ?? (query as any)?.data?.id ?? query['id'] ?? '';
    const manifest = `id:${dataId};request-id:${xRequestId ?? ''};ts:${ts}`;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(manifest)
      .digest('hex');

    return expected === v1;
  }

  // ─── Extrae paymentId de cualquier formato que envía MP ───────────────────

  private extractPaymentId(body: any, query: Record<string, string>): string | null {
    const candidates = [
      body?.data?.id,
      body?.id,
      query?.['data.id'],
      (query as any)?.data?.id,
      query?.id,
    ];
    for (const c of candidates) {
      if (c != null && !isNaN(Number(c))) return String(c);
    }
    return null;
  }

  // ─── Núcleo: procesa un paymentId ─────────────────────────────────────────
  // Usado por el webhook y por el endpoint de recuperación manual.
  // `expectedStoreId`: si se pasa, verifica que el pago pertenezca a esa tienda.

  async processPaymentById(
    paymentId:       string,
    expectedStoreId?: string,
  ): Promise<{ status: string; storeId?: string }> {
    if (!/^\d+$/.test(paymentId)) {
      throw new BadRequestException('El ID de pago debe ser numérico');
    }

    this.logger.log(`Procesando pago MP: ${paymentId}`);

    const paymentClient = new Payment(this.mpClient);
    let payment: any;

    try {
      payment = await paymentClient.get({ id: paymentId });
    } catch (err: any) {
      const code = err?.status ?? err?.cause?.[0]?.code;
      if (code === 404) throw new NotFoundException('Pago no encontrado en MercadoPago');
      throw err;
    }

    this.logger.log(`MP payment | id=${paymentId} status=${payment.status} ref=${payment.external_reference}`);

    const storeId = payment.external_reference;
    if (!storeId) {
      return { status: 'no_reference' };
    }

    // Seguridad: si viene de endpoint manual, verificar que pertenece a la tienda del usuario
    if (expectedStoreId && storeId !== expectedStoreId) {
      throw new ForbiddenException('Este pago no pertenece a tu cuenta');
    }

    const store = await this.prisma.store.findUnique({ where: { storeId } });
    if (!store) return { status: 'store_not_found' };

    const amount   = Number(payment.transaction_amount ?? 0);
    const mpStatus = payment.status ?? 'unknown';  // approved | pending | in_process | rejected | cancelled

    // Validar monto mínimo para evitar activaciones fraudulentas con pagos de $1
    if (mpStatus === 'approved') {
      const subConfig = await this.prisma.subscriptionConfig.findUnique({ where: { configId: 'singleton' } });
      const expectedPrice = subConfig ? Number(subConfig.priceAmount) : 24000;
      const tolerance     = expectedPrice * 0.05; // 5% de tolerancia para diferencias de cambio
      if (amount < expectedPrice - tolerance) {
        this.logger.warn(`Pago ${paymentId} rechazado: monto $${amount} insuficiente (mínimo $${expectedPrice - tolerance})`);
        return { status: 'amount_too_low', storeId };
      }
    }

    // Todo el procesamiento es atómico: si falla cualquier paso, nada se persiste
    try {
      await this.prisma.$transaction(async (tx) => {
        // Upsert subscription
        const sub = await tx.subscription.upsert({
          where:  { storeId },
          create: { storeId, status: mpStatus === 'approved' ? 'active' : 'pending', priceAmount: amount },
          update: { updatedAt: new Date() },
        });

        // Registrar pago — mpPaymentId @unique garantiza idempotencia incluso sin el try/catch externo
        await tx.subscriptionPayment.upsert({
          where:  { mpPaymentId: paymentId },
          create: {
            subscriptionId: sub.subscriptionId,
            mpPaymentId:    paymentId,
            amount,
            status:         mpStatus,
            paidAt:         mpStatus === 'approved' ? new Date() : null,
          },
          update: {
            status: mpStatus,
            ...(mpStatus === 'approved' && { paidAt: new Date() }),
          },
        });

        // Activar tienda solo si el pago fue aprobado
        if (mpStatus === 'approved') {
          const now = new Date();

          // Si el cliente renueva antes de vencer, sumar 30 días desde el vencimiento actual
          // Si ya venció o es la primera vez, sumar 30 días desde hoy
          const baseDate  = sub.currentPeriodEnd && sub.currentPeriodEnd > now
            ? sub.currentPeriodEnd
            : now;
          const periodEnd = new Date(baseDate);
          periodEnd.setDate(periodEnd.getDate() + 30);

          await tx.subscription.update({
            where: { storeId },
            data:  {
              status:             'active',
              currentPeriodStart: now,
              currentPeriodEnd:   periodEnd,
              priceAmount:        amount,
            },
          });

          await tx.store.update({
            where: { storeId },
            data:  {
              subscriptionStatus: 'active',
              subscriptionEnd:    periodEnd,
              apiBlocked:         false,
            },
          });

          this.logger.log(`Tienda activada | storeId=${storeId} hasta=${periodEnd.toISOString()}`);
        }
      });
    } catch (e: any) {
      // P2002 = unique constraint: el pago ya fue procesado (idempotencia)
      if (e.code === 'P2002') {
        this.logger.debug(`Pago ${paymentId} ya procesado (idempotencia)`);
        return { status: 'already_processed', storeId };
      }
      throw e;
    }

    return { status: mpStatus, storeId };
  }

  // ─── Estado de la suscripción del usuario ─────────────────────────────────

  async getMySubscription(storeId: string) {
    if (!storeId) throw new BadRequestException('Tienda no encontrada en la sesión');

    const store = await this.prisma.store.findUnique({
      where:  { storeId },
      select: { subscriptionStatus: true, subscriptionEnd: true, apiBlocked: true },
    });
    if (!store) throw new NotFoundException('Tienda no encontrada');

    const subscription = await this.prisma.subscription.findUnique({
      where:   { storeId },
      include: { payments: { orderBy: { createdAt: 'desc' }, take: 10 } },
    });

    const subConfig = await this.prisma.subscriptionConfig.findUnique({
      where: { configId: 'singleton' },
    });

    return {
      subscriptionStatus: store.subscriptionStatus,
      subscriptionEnd:    store.subscriptionEnd,
      apiBlocked:         store.apiBlocked,
      currentPrice:       subConfig ? Number(subConfig.priceAmount) : 24000,
      currency:           subConfig?.currency ?? 'COP',
      subscription,
    };
  }

  // ─── Cron: limpieza de registros sin pago tras 24h ─────────────────────────

  @Cron('0 * * * *', { name: 'cleanup-unpaid-registrations', timeZone: 'UTC' })
  async cleanupUnpaidRegistrations(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const unpaidStores = await this.prisma.store.findMany({
      where: {
        subscriptionStatus: 'pending',
        createdAt:          { lt: cutoff },
        OR: [
          { subscription: { is: null } },
          { subscription: { is: { payments: { none: { status: 'approved' } } } } },
        ],
      },
      select: { storeId: true, name: true },
    });

    if (unpaidStores.length === 0) return;

    this.logger.log(`Cleanup: eliminando ${unpaidStores.length} tiendas sin pago`);

    const storeIds = unpaidStores.map(s => s.storeId);
    let deleted = 0;

    // Eliminar en lotes de 10 para evitar queries masivos
    const BATCH = 10;
    for (let i = 0; i < storeIds.length; i += BATCH) {
      const batch = storeIds.slice(i, i + BATCH);
      try {
        // Transacción atómica: si falla una parte, el lote completo hace rollback
        await this.prisma.$transaction([
          this.prisma.user.deleteMany({ where: { storeId: { in: batch } } }),
          this.prisma.store.deleteMany({ where: { storeId: { in: batch } } }),
        ]);
        deleted += batch.length;
      } catch (err: any) {
        this.logger.error(`Cleanup batch error [${batch.join(',')}]: ${err.message}`);
      }
    }

    this.logger.log(`Cleanup completado: ${deleted}/${unpaidStores.length}`);
  }
}

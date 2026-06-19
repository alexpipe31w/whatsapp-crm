import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CustomersService } from '../customers/customers.service';
import { AppointmentsService } from '../appointments/appointments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { AppointmentSource } from '../generated/prisma/enums';
import { PublicBookingDto } from './dto/public-booking.dto';
import { PublicOrderDto } from './dto/public-order.dto';

interface SlotResult {
  staffId: string | null;
  name: string;
  slots: string[];
  occupiedSlots: string[];
}

type DayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

// Mismo criterio de normalización de teléfono que admin-assistant.findOrCreateCustomerByPhone:
// busca por coincidencia parcial (tolera formatos distintos) antes de crear, y canoniza a
// E.164 colombiano — así un cliente que ya escribió por WhatsApp no queda duplicado al
// agendar por el link público.
const normalizePhone = (p: string) => p.replace(/\D/g, '');

@Injectable()
export class PublicService {
  constructor(
    private readonly prisma:       PrismaService,
    private readonly customers:    CustomersService,
    private readonly appointments: AppointmentsService,
    private readonly notifications: NotificationsService,
    private readonly orders:       OrdersService,
  ) {}

  async getStoreBySlug(slug: string) {
    const store = await this.prisma.store.findUnique({
      where:  { slug },
      select: { storeId: true, name: true, staffLabel: true, businessHours: true },
    });
    if (!store) throw new NotFoundException('Negocio no encontrado');

    const [staffCount, services] = await Promise.all([
      this.prisma.staff.count({ where: { storeId: store.storeId, isActive: true } }),
      this.prisma.service.findMany({
        where:   { storeId: store.storeId, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: {
          serviceId:        true,
          name:             true,
          description:      true,
          priceType:        true,
          basePrice:        true,
          minPrice:         true,
          maxPrice:         true,
          unitLabel:        true,
          estimatedMinutes: true,
          imageUrl:         true,
          hasVariants:      true,
          variants: {
            where:   { isActive: true },
            orderBy: { sortOrder: 'asc' },
            select: {
              variantId:        true,
              name:             true,
              priceOverride:    true,
              estimatedMinutes: true,
            },
          },
        },
      }),
    ]);

    return {
      name:          store.name,
      staffLabel:    store.staffLabel ?? 'Profesional',
      hasStaff:      staffCount > 0,
      businessHours: store.businessHours,
      services,
    };
  }

  // ─── Tienda pública (plan de emergencia si la IA cae) ──────────────────────
  // Lista los productos publicables de la tienda resuelta por slug. El storeId
  // SIEMPRE sale del slug (multi-tenant), nunca del cliente.
  async getProductsBySlug(slug: string) {
    const store = await this.prisma.store.findUnique({
      where:  { slug },
      select: { storeId: true, name: true, paymentMethods: true },
    });
    if (!store) throw new NotFoundException('Negocio no encontrado');

    const products = await this.prisma.product.findMany({
      where:   { storeId: store.storeId, isActive: true, stock: { gt: 0 } },
      orderBy: { createdAt: 'asc' },
      select: {
        productId:   true,
        name:        true,
        description: true,
        salePrice:   true,
        stock:       true,
        imageUrl:    true,
        images:      true,
        hasVariants: true,
        variants: {
          where:   { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: { variantId: true, name: true, salePrice: true, stock: true },
        },
      },
    });

    return { name: store.name, paymentMethods: store.paymentMethods ?? [], products };
  }

  // Pedido público (plan de emergencia si la IA falla). storeId desde el slug,
  // precios leídos de la BD (nunca del cliente), creación delegada a
  // OrdersService.create que valida tenant y descuenta stock atómicamente.
  async createOrder(slug: string, dto: PublicOrderDto) {
    const store = await this.prisma.store.findUnique({
      where:  { slug },
      select: { storeId: true },
    });
    if (!store) throw new NotFoundException('Negocio no encontrado');
    const { storeId } = store;

    const digits = normalizePhone(dto.customerPhone);
    if (digits.length < 7) throw new BadRequestException('El número de teléfono no es válido.');

    const customer = await this.findOrCreateCustomerByPhone(storeId, digits, dto.customerName.trim());

    // Resolver precio y validar pertenencia de cada item desde la BD (nunca confiar en el cliente).
    const items: {
      productId: string;
      variantId?: string;
      quantity: number;
      unitPrice: number;
      description: string;
    }[] = [];
    for (const it of dto.items) {
      const product = await this.prisma.product.findFirst({
        where:  { productId: it.productId, storeId, isActive: true },
        select: { productId: true, name: true, salePrice: true },
      });
      if (!product) throw new BadRequestException('Un producto seleccionado no existe.');

      let unitPrice = Number(product.salePrice);
      let variantId: string | undefined;
      if (it.variantId) {
        const variant = await this.prisma.productVariant.findFirst({
          where:  { variantId: it.variantId, product: { storeId } },
          select: { variantId: true, salePrice: true },
        });
        if (!variant) throw new BadRequestException('Una variante seleccionada no existe.');
        variantId = variant.variantId;
        if (variant.salePrice != null) unitPrice = Number(variant.salePrice);
      }

      items.push({
        productId:   product.productId,
        variantId,
        quantity:    it.quantity,
        unitPrice,
        description: product.name,
      });
    }

    // CreateOrderDto no expone un campo de pago con el set de valores del público,
    // así que el método de pago elegido (a coordinar en el local) se guarda en notas.
    const noteParts: string[] = [];
    if (dto.notes?.trim()) noteParts.push(dto.notes.trim());
    if (dto.paymentMethod) noteParts.push(`Método de pago: ${dto.paymentMethod}`);
    const notes = noteParts.length ? noteParts.join(' — ').slice(0, 500) : undefined;

    const order = await this.orders.create({
      storeId,
      customerId:     customer.customerId,
      items,
      notes,
      idempotencyKey: `pub-${storeId}-${customer.customerId}-${Date.now()}`,
    });

    return {
      orderId: order.orderId,
      total:   order.total,
      status:  order.status,
    };
  }

  // ─── Auto-agendamiento público (plan de emergencia) ────────────────────────
  // El storeId SIEMPRE se resuelve desde el slug — nunca se confía en datos del
  // cliente para identificar la tienda (mismo principio multi-tenant que el resto
  // de la plataforma). La creación real se delega a AppointmentsService.create,
  // que ya valida horario laboral y conflictos de agenda dentro de una transacción
  // atómica — así una cita agendada aquí jamás puede chocar con una creada por la
  // IA o por el staff.
  async bookAppointment(slug: string, dto: PublicBookingDto) {
    const store = await this.prisma.store.findUnique({
      where:  { slug },
      select: { storeId: true },
    });
    if (!store) throw new NotFoundException('Negocio no encontrado');
    const { storeId } = store;

    const digits = normalizePhone(dto.customerPhone);
    if (digits.length < 7) {
      throw new BadRequestException('El número de teléfono no es válido.');
    }

    const customer = await this.findOrCreateCustomerByPhone(storeId, digits, dto.customerName.trim());

    let durationMinutes: number | undefined;
    if (dto.serviceVariantId) {
      const variant = await this.prisma.serviceVariant.findFirst({
        where:  { variantId: dto.serviceVariantId, service: { storeId } },
        select: { estimatedMinutes: true },
      });
      if (!variant) throw new BadRequestException('La variante de servicio seleccionada no existe.');
      durationMinutes = variant.estimatedMinutes ?? undefined;
    } else if (dto.serviceId) {
      const service = await this.prisma.service.findFirst({
        where:  { serviceId: dto.serviceId, storeId },
        select: { estimatedMinutes: true },
      });
      if (!service) throw new BadRequestException('El servicio seleccionado no existe.');
      durationMinutes = service.estimatedMinutes ?? undefined;
    }

    if (dto.staffId) {
      const staff = await this.prisma.staff.findFirst({
        where:  { staffId: dto.staffId, storeId, isActive: true },
        select: { staffId: true },
      });
      if (!staff) throw new BadRequestException('El profesional seleccionado no está disponible.');
    }

    const appointment = await this.appointments.create(storeId, {
      customerId:       customer.customerId,
      serviceId:        dto.serviceId,
      serviceVariantId: dto.serviceVariantId,
      staffId:          dto.staffId,
      scheduledAt:      dto.scheduledAt,
      durationMinutes,
      notes:            dto.notes,
      source:           AppointmentSource.API,
    });

    this.notifications.notifyAppointmentCreated(appointment as any, 'public').catch(() => {});

    return {
      appointmentId: appointment.appointmentId,
      status:        appointment.status,
      scheduledAt:   appointment.scheduledAt,
      service:       appointment.service?.name ?? null,
      staff:         appointment.staff?.name ?? null,
    };
  }

  private async findOrCreateCustomerByPhone(storeId: string, digits: string, name: string) {
    const existing = await this.prisma.customer.findFirst({
      where: { storeId, phone: { contains: digits.slice(-9) } },
    });
    if (existing) return existing;

    const canonicalPhone = digits.length === 10 && digits.startsWith('3') ? `+57${digits}` : `+${digits}`;
    return this.customers.findOrCreate({ storeId, phone: canonicalPhone, name });
  }

  async getAvailability(slug: string, dateStr: string): Promise<{ date: string; dayName: string; staff: SlotResult[] }> {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new BadRequestException('Parámetro date requerido en formato YYYY-MM-DD');
    }

    const store = await this.prisma.store.findUnique({
      where:  { slug },
      select: { storeId: true, name: true, businessHours: true },
    });
    if (!store) throw new NotFoundException('Negocio no encontrado');

    // Parse date in Colombia TZ (UTC-5)
    const date     = new Date(`${dateStr}T05:00:00.000Z`);
    const dayNames = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const dayName  = dayNames[date.getDay()];

    const activeStaff = await this.prisma.staff.findMany({
      where:   { storeId: store.storeId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select:  { staffId: true, name: true, schedule: true },
    });

    const results: SlotResult[] = [];
    const startOfDay = new Date(`${dateStr}T05:00:00.000Z`);
    // FIX: "T28:59:59.000Z" no es una hora ISO válida (>23h) → Invalid Date → 500 en Prisma.
    // Medianoche del día siguiente en hora Colombia = inicio del día + 24h, sin importar
    // si cruza fin de mes o de año (construir el string a mano no lo manejaba).
    const endOfDay   = new Date(startOfDay.getTime() + 24 * 60 * 60_000);

    if (activeStaff.length === 0) {
      const hours = store.businessHours as Record<string, any> | null;
      if (!hours) return { date: dateStr, dayName, staff: [] };

      const appts = await this.prisma.appointment.findMany({
        where: {
          storeId:     store.storeId,
          staffId:     null,
          status:      { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
          scheduledAt: { gte: startOfDay, lt: endOfDay },
        },
        select: { scheduledAt: true, endsAt: true },
      });

      const { available, occupied } = this.computeSlots(date, hours, appts);
      results.push({ staffId: null, name: store.name, slots: available, occupiedSlots: occupied });
    } else {
      for (const member of activeStaff) {
        const hours = (member.schedule ?? store.businessHours) as Record<string, any> | null;
        const appts = await this.prisma.appointment.findMany({
          where: {
            storeId:     store.storeId,
            staffId:     member.staffId,
            status:      { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
            scheduledAt: { gte: startOfDay, lt: endOfDay },
          },
          select: { scheduledAt: true, endsAt: true },
        });

        const { available, occupied } = hours
          ? this.computeSlots(date, hours, appts)
          : { available: [], occupied: [] };
        results.push({
          staffId:      member.staffId,
          name:         member.name,
          slots:        available,
          occupiedSlots: occupied,
        });
      }
    }

    return { date: dateStr, dayName, staff: results };
  }

  private computeSlots(
    date: Date,
    hours: Record<string, any>,
    appointments: { scheduledAt: Date; endsAt: Date | null }[],
    slotMinutes = 30,
  ): { available: string[]; occupied: string[] } {
    const DAY_KEYS: DayKey[] = ['sun','mon','tue','wed','thu','fri','sat'];
    const dayKey    = DAY_KEYS[date.getDay()];
    const daySchedule = hours[dayKey];

    if (!daySchedule?.isOpen) return { available: [], occupied: [] };

    const shifts: { open: string; close: string }[] =
      [daySchedule.shift1, daySchedule.shift2].filter(Boolean);

    const allSlots: string[] = [];

    for (const shift of shifts) {
      const [openH, openM]   = shift.open.split(':').map(Number);
      const [closeH, closeM] = shift.close.split(':').map(Number);
      let cur = openH * 60 + openM;
      const end = closeH * 60 + closeM;
      while (cur + slotMinutes <= end) {
        const hh = String(Math.floor(cur / 60)).padStart(2, '0');
        const mm = String(cur % 60).padStart(2, '0');
        allSlots.push(`${hh}:${mm}`);
        cur += slotMinutes;
      }
    }

    const now = new Date();
    const available: string[] = [];
    const occupied: string[] = [];

    for (const slot of allSlots) {
      const [h, m]    = slot.split(':').map(Number);
      const slotStart = new Date(date);
      slotStart.setUTCHours(h + 5, m, 0, 0); // Colombia UTC-5 → UTC
      const slotEnd   = new Date(slotStart.getTime() + slotMinutes * 60_000);

      if (slotStart < now) continue; // slots pasados no se muestran

      const isBusy = appointments.some(appt => {
        const s = new Date(appt.scheduledAt);
        const e = appt.endsAt ? new Date(appt.endsAt) : new Date(s.getTime() + 30 * 60_000);
        return s < slotEnd && e > slotStart;
      });

      if (isBusy) occupied.push(slot);
      else available.push(slot);
    }

    return { available, occupied };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { jidFromPhone } from '../utils/wa-identity.util';
import {
  KIND_PRIORITY,
  KIND_TTL_MS,
  OutboundKind,
  OutboundPayload,
} from './outbound.types';
import { OutboundSignal } from './outbound.signal';

export interface EnqueueInput {
  storeId: string;
  /** Identidad del destinatario: teléfono ("+57…") o "lid:<user>". Se resuelve a jid al encolar. */
  to: string;
  text: string;
  kind: OutboundKind;
  /** Clave de idempotencia (outbound-keys.ts). Misma clave = una sola fila. */
  key: string;
  notBefore?: Date;
  /** Por defecto notBefore + KIND_TTL_MS[kind]. */
  expiresAt?: Date;
  groupKey?: string;
  record?: { conversationId: string };
}

/** queued = fila nueva; duplicate = ya existía esa clave; invalid = no se encola (texto vacío o sin destino). */
export type EnqueueResult = 'queued' | 'duplicate' | 'invalid';

const MAX_KEY_LENGTH = 200;
const MAX_GROUP_LENGTH = 120;

/**
 * Cola de salida de WhatsApp. Encolar es `INSERT … ON CONFLICT (idempotency_key) DO
 * NOTHING`: reintentar, duplicar un webhook o un doble clic nunca deja dos filas.
 * Con `tx`, la fila nace dentro de la transacción de negocio del llamador.
 * Nunca registra el texto ni el teléfono: solo tienda, tipo y clave.
 */
@Injectable()
export class OutboundService {
  private readonly logger = new Logger(OutboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly signal: OutboundSignal,
  ) {}

  async enqueue(
    input: EnqueueInput,
    tx?: Prisma.TransactionClient,
  ): Promise<EnqueueResult> {
    const row = this.toRow(input, new Date());
    if (!row) return 'invalid';
    const db: Prisma.TransactionClient = tx ?? this.prisma;
    const { count } = await db.waOutbound.createMany({
      data: [row],
      skipDuplicates: true,
    });
    if (count === 0) {
      this.logger.debug(
        `[outbound] duplicado ignorado kind=${input.kind} store=${input.storeId} key=${input.key}`,
      );
      return 'duplicate';
    }
    this.logger.log(
      `[outbound] encolado kind=${input.kind} store=${input.storeId} key=${input.key}`,
    );
    if (!tx) this.signal.wake();
    return 'queued';
  }

  /** Inserción en bloque (campañas). Devuelve cuántas filas nuevas quedaron. */
  async enqueueMany(
    inputs: EnqueueInput[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const now = new Date();
    const rows = inputs
      .map((i) => this.toRow(i, now))
      .filter((r): r is Prisma.WaOutboundCreateManyInput => r !== null);
    if (rows.length === 0) return 0;
    const db: Prisma.TransactionClient = tx ?? this.prisma;
    const { count } = await db.waOutbound.createMany({
      data: rows,
      skipDuplicates: true,
    });
    const first = inputs[0];
    this.logger.log(
      `[outbound] encoladas ${count}/${rows.length} kind=${first.kind} store=${first.storeId}` +
        (first.groupKey ? ` grupo=${first.groupKey}` : ''),
    );
    if (!tx && count > 0) this.signal.wake();
    return count;
  }

  /** Avisa al despachador. Llamar después del commit cuando se encoló dentro de una transacción. */
  wake(): void {
    this.signal.wake();
  }

  /** Marca como skipped las pendientes de un grupo (p. ej. reprogramar un recordatorio). */
  async cancelGroup(
    groupKey: string,
    reason: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const db: Prisma.TransactionClient = tx ?? this.prisma;
    const { count } = await db.waOutbound.updateMany({
      where: { groupKey, status: 'pending' },
      data: { status: 'skipped', lastError: reason.slice(0, 500) },
    });
    if (count > 0)
      this.logger.log(
        `[outbound] ${count} pendiente(s) cancelada(s) grupo=${groupKey} motivo=${reason}`,
      );
    return count;
  }

  /** Como cancelGroup, para todos los grupos que empiezan por `prefix`. */
  async cancelGroupsByPrefix(prefix: string, reason: string): Promise<number> {
    const { count } = await this.prisma.waOutbound.updateMany({
      where: { groupKey: { startsWith: prefix }, status: 'pending' },
      data: { status: 'skipped', lastError: reason.slice(0, 500) },
    });
    if (count > 0)
      this.logger.log(
        `[outbound] ${count} pendiente(s) cancelada(s) grupos=${prefix}* motivo=${reason}`,
      );
    return count;
  }

  private toRow(
    input: EnqueueInput,
    now: Date,
  ): Prisma.WaOutboundCreateManyInput | null {
    if (input.key.length > MAX_KEY_LENGTH) {
      throw new Error(
        `[outbound] clave de más de ${MAX_KEY_LENGTH} caracteres: ${input.key.slice(0, 60)}…`,
      );
    }
    if (input.groupKey && input.groupKey.length > MAX_GROUP_LENGTH) {
      throw new Error(
        `[outbound] grupo de más de ${MAX_GROUP_LENGTH} caracteres: ${input.groupKey.slice(0, 60)}…`,
      );
    }
    if (!input.text?.trim()) {
      this.logger.warn(
        `[outbound] texto vacío: no se encola store=${input.storeId} key=${input.key}`,
      );
      return null;
    }
    const toJid = jidFromPhone(input.to ?? '');
    if (toJid.startsWith('@')) {
      this.logger.warn(
        `[outbound] destinatario sin número ni LID: no se encola store=${input.storeId} key=${input.key}`,
      );
      return null;
    }
    const notBefore = input.notBefore ?? now;
    const payload: OutboundPayload = input.record
      ? { text: input.text, record: input.record }
      : { text: input.text };
    return {
      storeId: input.storeId,
      toJid,
      payload: payload as unknown as Prisma.InputJsonValue,
      kind: input.kind,
      priority: KIND_PRIORITY[input.kind],
      idempotencyKey: input.key,
      groupKey: input.groupKey ?? null,
      notBefore,
      expiresAt:
        input.expiresAt ??
        new Date(notBefore.getTime() + KIND_TTL_MS[input.kind]),
    };
  }
}

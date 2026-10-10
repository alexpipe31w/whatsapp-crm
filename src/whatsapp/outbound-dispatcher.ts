import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OUTBOUND_CONFIG } from '../outbound/outbound.tokens';
import { OutboundConfig } from '../outbound/outbound-config';
import { OutboundSignal } from '../outbound/outbound.signal';
import { OutboundPayload } from '../outbound/outbound.types';
import { decideOnFailure } from './outbound-retry';
import {
  classifySendError,
  isNotAcceptable,
  SendTimeoutError,
} from './send-errors';
import { splitForWhatsapp } from './split-text';
import { WA_TRANSPORT, WaTransport } from './wa-transport';

interface ClaimedRow {
  id: string;
  store_id: string;
  to_jid: string;
  payload: OutboundPayload;
  kind: string;
  attempts: number;
  provider_message_ids: string[];
  claim_token: string;
}

/**
 * Hora del PROCESO como timestamp UTC sin zona, el mismo formato en que Prisma guarda los
 * DateTime. Todas las horas de wa_outbound (not_before, expires_at, …) las escribe la app
 * con su reloj; compararlas con now() de Postgres mezclaría dos relojes (en tests, el
 * Postgres de WSL va desfasado y una fila recién encolada parecía "del futuro").
 */
function at(offsetMs = 0): Prisma.Sql {
  const iso = new Date(Date.now() + offsetMs).toISOString();
  return Prisma.sql`${iso.slice(0, 23).replace('T', ' ')}::timestamp(3)`;
}

/** Texto de un error para logs y last_error (sin volcar objetos). */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'error desconocido';
}

/**
 * Despachador de wa_outbound (bloque 1a: en el mismo proceso; en 1c se muda al gateway).
 * - Un envío en curso por tienda: la consulta de candidatos lo excluye y el índice único
 *   parcial wa_outbound_one_sending_per_store lo garantiza en BD.
 * - Reclamo atómico: UPDATE … WHERE status='pending' sobre la fila FOR UPDATE SKIP LOCKED.
 * - Las escrituras de cierre llevan WHERE claim_token: quien perdió el arriendo no pisa a otro.
 * - "Al menos una vez": si el proceso muere entre que WhatsApp acepta un trozo y se guarda,
 *   ese trozo puede repetirse (Baileys no deduplica). Inevitable y acotado a un trozo.
 * Nunca registra textos ni teléfonos: id de fila, tienda, tipo e intentos.
 */
@Injectable()
export class OutboundDispatcher
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboundDispatcher.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly signal: OutboundSignal,
    @Inject(WA_TRANSPORT) private readonly transport: WaTransport,
    @Inject(OUTBOUND_CONFIG) private readonly cfg: OutboundConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cfg.dispatcherEnabled) {
      this.logger.log(
        '[outbound] despachador apagado (WA_OUTBOUND_DISPATCHER=off)',
      );
      return;
    }
    this.signal.onWake(() => this.kick());
    this.timer = setInterval(() => this.kick(), this.cfg.pollMs);
    this.timer.unref();
    this.kick();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private kick(): void {
    if (this.stopped) return;
    this.tick().catch((err) =>
      this.logger.error(`[outbound] pasada fallida: ${errorText(err)}`),
    );
  }

  /**
   * Una pasada: caduca, recupera huérfanas y envía hasta vaciar lo que está listo (o
   * maxLoopsPerTick vueltas). Si ya hay una en marcha, devuelve esa y apunta otra para
   * después (solo con el despachador encendido). Devuelve cuántas filas atendió.
   */
  tick(): Promise<number> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.runPass().finally(() => {
      this.running = null;
      const again = this.rerun && !this.stopped && this.cfg.dispatcherEnabled;
      this.rerun = false;
      if (again) setImmediate(() => this.kick());
    });
    return this.running;
  }

  private async runPass(): Promise<number> {
    await this.expire();
    await this.recoverOrphans();
    let total = 0;
    for (let loop = 0; loop < this.cfg.maxLoopsPerTick; loop++) {
      const ids = await this.candidates();
      if (ids.length === 0) break;
      const results = await Promise.all(ids.map((id) => this.processOne(id)));
      const done = results.filter(Boolean).length;
      total += done;
      if (done === 0) break;
    }
    return total;
  }

  private async expire(): Promise<void> {
    const n = await this.prisma.$executeRaw`
      UPDATE wa_outbound SET status = 'skipped', last_error = 'caducado', updated_at = ${at()}
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ${at()}`;
    if (n > 0)
      this.logger.warn(
        `[outbound] ${n} fila(s) caducadas sin enviar → skipped`,
      );
  }

  private async recoverOrphans(): Promise<void> {
    const n = await this.prisma.$executeRaw`
      UPDATE wa_outbound SET
        attempts = attempts + 1,
        status = CASE WHEN attempts + 1 >= ${this.cfg.maxAttempts} THEN 'failed' ELSE 'pending' END,
        last_error = 'arriendo vencido (¿el proceso murió enviando?)',
        claim_token = NULL, locked_until = NULL, not_before = ${at()}, updated_at = ${at()}
      WHERE status = 'sending' AND locked_until < ${at()}`;
    if (n > 0)
      this.logger.warn(`[outbound] ${n} fila(s) huérfana(s) recuperada(s)`);
  }

  /** La siguiente fila lista de cada tienda sin envío en curso (máx. maxParallel tiendas). */
  private async candidates(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM (
        SELECT DISTINCT ON (o.store_id) o.id, o.priority, o.created_at
        FROM wa_outbound o
        WHERE o.status = 'pending' AND o.not_before <= ${at()}
          AND NOT EXISTS (SELECT 1 FROM wa_outbound s WHERE s.store_id = o.store_id AND s.status = 'sending')
          AND NOT EXISTS (
            SELECT 1 FROM wa_outbound p
            WHERE p.store_id = o.store_id AND p.to_jid = o.to_jid AND p.status = 'pending'
              AND p.attempts > 0 AND p.created_at < o.created_at AND p.id <> o.id)
        ORDER BY o.store_id, o.priority, o.created_at
      ) c
      ORDER BY c.priority, c.created_at
      LIMIT ${this.cfg.maxParallel}`;
    return rows.map((r) => r.id);
  }

  /** Reclama y envía una fila. true si la atendió (enviada, fallida o reprogramada). */
  private async processOne(id: string): Promise<boolean> {
    const row = await this.claim(id);
    if (!row) return false;
    const parts = splitForWhatsapp(row.payload.text);
    try {
      for (let i = row.provider_message_ids.length; i < parts.length; i++) {
        const waId = await this.withTimeout(
          this.transport.sendPart(row.store_id, row.to_jid, parts[i]),
        );
        await this.prisma.$executeRaw`
          UPDATE wa_outbound SET provider_message_ids = array_append(provider_message_ids, ${waId}), updated_at = ${at()}
          WHERE id = ${row.id} AND claim_token = ${row.claim_token}`;
      }
    } catch (err) {
      await this.onFailure(row, err);
      return true;
    }
    await this.onSent(row);
    return true;
  }

  private async claim(id: string): Promise<ClaimedRow | null> {
    const token = randomUUID();
    try {
      const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
        UPDATE wa_outbound SET status = 'sending', claim_token = ${token},
          locked_until = ${at(this.cfg.leaseMs)}, updated_at = ${at()}
        WHERE id = (SELECT id FROM wa_outbound WHERE id = ${id} AND status = 'pending' FOR UPDATE SKIP LOCKED)
        RETURNING id, store_id, to_jid, payload, kind, attempts, provider_message_ids, claim_token`;
      return rows[0] ?? null;
    } catch (err) {
      // Otro despachador ya envía para esa tienda (índice único parcial).
      if (errorText(err).includes('wa_outbound_one_sending_per_store'))
        return null;
      throw err;
    }
  }

  private async onSent(row: ClaimedRow): Promise<void> {
    const closed = await this.prisma.$executeRaw`
      UPDATE wa_outbound SET status = 'sent', sent_at = ${at()}, claim_token = NULL, locked_until = NULL,
        last_error = NULL, updated_at = ${at()}
      WHERE id = ${row.id} AND claim_token = ${row.claim_token}`;
    if (closed === 0) {
      this.logger.warn(
        `[outbound] fila ${row.id} enviada pero el arriendo ya no era nuestro`,
      );
      return;
    }
    this.logger.log(
      `[outbound] enviado id=${row.id} kind=${row.kind} store=${row.store_id}`,
    );
    if (row.kind === 'campaign') await this.applyCampaignGap(row.store_id);
    if (row.payload.record?.conversationId) await this.recordMessage(row);
  }

  private async onFailure(row: ClaimedRow, err: unknown): Promise<void> {
    const errorClass = classifySendError(err);
    const decision = decideOnFailure(
      errorClass,
      isNotAcceptable(err),
      row.attempts,
      this.cfg,
    );
    const message = errorText(err).slice(0, 500);
    const notBefore = decision.delayMs === null ? at() : at(decision.delayMs);
    await this.prisma.$executeRaw`
      UPDATE wa_outbound SET status = ${decision.status}, attempts = ${decision.attempts}, last_error = ${message},
        not_before = ${notBefore}, claim_token = NULL, locked_until = NULL, updated_at = ${at()}
      WHERE id = ${row.id} AND claim_token = ${row.claim_token}`;
    if (decision.postponeStore && decision.delayMs !== null) {
      await this.prisma.$executeRaw`
        UPDATE wa_outbound SET not_before = ${at(decision.delayMs)}, updated_at = ${at()}
        WHERE store_id = ${row.store_id} AND status = 'pending' AND not_before < ${at(decision.delayMs)}`;
    }
    const line =
      `[outbound] fallo id=${row.id} kind=${row.kind} store=${row.store_id} clase=${errorClass} ` +
      `intentos=${decision.attempts} → ${decision.status}: ${message}`;
    if (decision.status === 'failed') this.logger.error(line);
    else this.logger.warn(line);
  }

  /** El hueco entre mensajes de campaña se guarda en BD (not_before): sobrevive a reinicios. */
  private async applyCampaignGap(storeId: string): Promise<void> {
    const { campaignGapMinMs: min, campaignGapMaxMs: max } = this.cfg;
    if (max === 0) return;
    const gap = Math.round(min + Math.random() * (max - min));
    await this.prisma.$executeRaw`
      UPDATE wa_outbound SET not_before = GREATEST(not_before, ${at(gap)}), updated_at = ${at()}
      WHERE store_id = ${storeId} AND kind = 'campaign' AND status = 'pending'`;
  }

  /** Mejor esfuerzo y después del sent: que falle no puede reenviar el mensaje. */
  private async recordMessage(row: ClaimedRow): Promise<void> {
    const conversationId = row.payload.record!.conversationId;
    try {
      await this.prisma.$transaction([
        this.prisma.message.create({
          data: {
            conversationId,
            storeId: row.store_id,
            content: row.payload.text,
            type: 'text',
            sender: 'store',
            isAiResponse: true,
          },
        }),
        this.prisma.conversation.update({
          where: { conversationId },
          data: { lastMessageAt: new Date() },
        }),
      ]);
    } catch (err) {
      this.logger.warn(
        `[outbound] enviado pero no guardado en messages id=${row.id} conv=${conversationId}: ${errorText(err)}`,
      );
    }
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    const limit = this.cfg.sendTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new SendTimeoutError(limit)), limit);
      }),
    ]).finally(() => clearTimeout(timer));
  }
}

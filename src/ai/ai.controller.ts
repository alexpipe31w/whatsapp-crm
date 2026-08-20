import { Controller, Post, Get, Body, Param, UseGuards, Request, ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAiConfigDto } from './dto/create-ai-config.dto';
import { buildCartridgeList, Cartridge, getPoolSnapshot } from './key-pool';
import { normalizeCartridgeModel } from './providers';

// ─── Verify a single API key by hitting the provider's lightweight models endpoint ──

type VerifyStatus = 'valid' | 'invalid' | 'rate_limited' | 'timeout' | 'error';

interface VerifyResult {
  provider:  string;
  maskedKey: string;
  model:     string;
  status:    VerifyStatus;
  detail?:   string;
}

const VERIFY_TIMEOUT_MS = 6000;

const maskKey = (k: string) => k.length > 4 ? `...${k.slice(-4)}` : '****';

async function verifyCartridge(c: Cartridge): Promise<VerifyResult> {
  const base: Omit<VerifyResult, 'status' | 'detail'> = {
    provider:  c.provider,
    maskedKey: maskKey(c.apiKey),
    model:     c.model,
  };

  let url: string;
  let headers: Record<string, string>;

  switch (c.provider) {
    case 'groq':
      url     = 'https://api.groq.com/openai/v1/models';
      headers = { Authorization: `Bearer ${c.apiKey}` };
      break;
    case 'openai':
      url     = 'https://api.openai.com/v1/models';
      headers = { Authorization: `Bearer ${c.apiKey}` };
      break;
    case 'anthropic':
      url     = 'https://api.anthropic.com/v1/models';
      headers = { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' };
      break;
    case 'together':
      url     = 'https://api.together.xyz/v1/models';
      headers = { Authorization: `Bearer ${c.apiKey}` };
      break;
    case 'mistral':
      url     = 'https://api.mistral.ai/v1/models';
      headers = { Authorization: `Bearer ${c.apiKey}` };
      break;
    case 'gemini':
      url     = `https://generativelanguage.googleapis.com/v1beta/models?key=${c.apiKey}&pageSize=1`;
      headers = {};
      break;
    default:
      return { ...base, status: 'error', detail: 'Proveedor desconocido' };
  }

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);

    if (res.ok)                                    return { ...base, status: 'valid' };
    if (res.status === 401 || res.status === 403)  return { ...base, status: 'invalid' };
    if (res.status === 429)                        return { ...base, status: 'rate_limited' };
    return { ...base, status: 'error', detail: `HTTP ${res.status}` };
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') return { ...base, status: 'timeout' };
    return { ...base, status: 'error', detail: String(err?.message ?? err).slice(0, 80) };
  }
}

// ─── Controller ───────────────────────────────────────────────────────────────

@UseGuards(JwtAuthGuard)
@Controller('ai-config')
export class AiController {
  constructor(private prisma: PrismaService) {}

  @Post()
  async create(@Body() dto: CreateAiConfigDto, @Request() req: any) {
    const storeId = req.user.storeId;
    const { storeId: _ignored, ...updateData } = dto as any;

    // Normalizar el modelo al guardar: gemini capado (2.0-flash → 429 "limit:0", 1.5 →
    // 404) y groq de la familia llama (decomisionada, 404) se fijan al default vivo del
    // proveedor. Evita que agregar una key deje el pool inservible. Ver providers.ts.
    if (Array.isArray(updateData.cartridges)) {
      updateData.cartridges = updateData.cartridges.map((c: any) => ({
        ...c,
        model: normalizeCartridgeModel(c.provider, c.model),
      }));
    }
    if (updateData.aiProvider && updateData.model !== undefined) {
      updateData.model = normalizeCartridgeModel(updateData.aiProvider, updateData.model);
    }

    return this.prisma.aIConfiguration.upsert({
      where: { storeId },
      update: updateData,
      create: { ...updateData, storeId },
    });
  }

  // IMPORTANTE: rutas estáticas DEBEN ir antes de ':storeId' para que NestJS no las confunda

  @Get('pool-status')
  async poolStatus(@Request() req: any) {
    return getPoolSnapshot(req.user.storeId);
  }

  @Post('verify-keys')
  async verifyKeys(@Request() req: any): Promise<{ cartridges: VerifyResult[] }> {
    const storeId = req.user.storeId;
    const cfg = await this.prisma.aIConfiguration.findUnique({ where: { storeId } });
    if (!cfg?.apiKey) return { cartridges: [] };

    const cartridges = buildCartridgeList(cfg as any);
    const results    = await Promise.all(cartridges.map(c => verifyCartridge(c)));
    return { cartridges: results };
  }

  @Get(':storeId')
  async findOne(@Param('storeId') storeId: string, @Request() req: any) {
    if (req.user.storeId !== storeId)
      throw new ForbiddenException('No puedes ver la configuración de otra tienda');
    return this.prisma.aIConfiguration.findUnique({ where: { storeId } });
  }
}

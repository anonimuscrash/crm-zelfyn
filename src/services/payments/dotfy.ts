// ============================================================
// Integração Dotfy — cobrança PIX.
//
// Construído a partir da documentação oficial (dotfy.apidog.io), não
// de suposição:
//
//   POST /api/charges          criar cobrança PIX
//   GET  /api/charges/{corrId} consultar por correlationID
//   GET  /api/auth/me          teste de saúde da chave
//
//   Authorization: Bearer {apiKey}
//   Chave: vk_live_* produção · vk_test_* sandbox
//
// DETALHES DA API QUE MOLDARAM ESTE CÓDIGO
// ----------------------------------------
//   • O corpo recebe `value` em REAIS ("29.90"), mas a resposta
//     devolve `value` em CENTAVOS (2990). A conversão nos dois
//     sentidos vive aqui e só aqui — deixá-la vazar seria a origem
//     garantida de uma cobrança 100× maior.
//   • `correlationID` NÃO é aceito como entrada. Quem gera é a
//     Dotfy. Então o id de conciliação só existe depois da resposta.
//   • O webhook assina com HMAC-SHA256 sobre `timestamp + "." +
//     body`, no header `X-Webhook-Signature: t=...,v1=...`.
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE_URL = 'https://api.dotfy.com.br';

export type PaymentEnvironment = 'sandbox' | 'production';

export class PaymentError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'PaymentError';
    this.status = status;
  }
}

export interface CreateChargeRequest {
  /** Valor em CENTAVOS. Convertido para reais na borda. */
  amountCents: number;
  description?: string | null;
  /** Segundos até expirar. 60 a 86400. */
  expiresIn?: number;
  customer?: {
    name?: string | null;
    taxID?: string | null;
    email?: string | null;
    /** E.164, ex: +5511999998888. */
    phone?: string | null;
  };
  webhookUrl?: string | null;
}

export interface ChargeResult {
  correlationId: string;
  externalId: string | null;
  /** BR Code copia-e-cola. Começa com "00020". */
  qrCode: string;
  /** Data URL da imagem, ou URL absoluta conforme o adquirente. */
  qrCodeImage: string | null;
  paymentLink: string | null;
  amountCents: number;
  expiresAt: string | null;
}

/**
 * Ambiente derivado do prefixo da chave.
 *
 * A Dotfy não usa URLs diferentes — o ambiente está na credencial.
 * Derivar em vez de perguntar evita a inconsistência mais provável
 * aqui: a conta marcada como produção usando chave de teste, e o
 * operador descobrindo quando o dinheiro não cai.
 */
export function environmentFromKey(apiKey: string): PaymentEnvironment {
  return apiKey.trim().startsWith('vk_live_') ? 'production' : 'sandbox';
}

export function isValidApiKey(apiKey: string): boolean {
  const k = apiKey.trim();
  return /^vk_(live|test)_[A-Za-z0-9._-]{10,}$/.test(k);
}

export class DotfyProvider {
  constructor(private readonly apiKey: string) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;

    try {
      res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          accept: 'application/json',
          ...init.headers,
        },
        // Gerar cobrança acontece no meio de um atendimento. Melhor
        // errar rápido que segurar a tela do vendedor.
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new PaymentError('Serviço de pagamento indisponível', 503);
    }

    if (res.status === 401) {
      throw new PaymentError('Chave da Dotfy inválida ou revogada', 502);
    }
    if (res.status === 403) {
      throw new PaymentError(
        'A chave não tem permissão para esta operação. Verifique os escopos e se o KYC está aprovado.',
        502
      );
    }
    if (res.status === 429) {
      throw new PaymentError(
        'Limite de requisições atingido. Tente em alguns instantes.',
        429
      );
    }

    const corpo = (await res.json().catch(() => null)) as
      | { success?: boolean; data?: unknown; message?: string; error?: string }
      | null;

    if (!res.ok || corpo?.success === false) {
      const detalhe = corpo?.message ?? corpo?.error ?? `HTTP ${res.status}`;
      throw new PaymentError(`Dotfy: ${String(detalhe).slice(0, 200)}`, 502);
    }

    return (corpo?.data ?? corpo) as T;
  }

  /** Valida a chave. `GET /api/auth/me` é o teste de saúde oficial. */
  async verifyKey(): Promise<{ ok: true }> {
    await this.call('/api/auth/me');
    return { ok: true };
  }

  async createCharge(request: CreateChargeRequest): Promise<ChargeResult> {
    if (request.amountCents <= 0) {
      throw new PaymentError('Valor deve ser maior que zero', 400);
    }
    // Teto documentado: 1.000.000 reais.
    if (request.amountCents > 100_000_000) {
      throw new PaymentError('Valor acima do limite da Dotfy', 400);
    }

    const body: Record<string, unknown> = {
      // A API recebe REAIS. Duas casas: `2990/100` é 29.9, e um
      // valor com uma casa decimal já foi recusado por gateway antes.
      value: Number((request.amountCents / 100).toFixed(2)),
    };

    if (request.description?.trim()) {
      body.description = request.description.trim().slice(0, 255);
    }
    if (request.expiresIn) {
      body.expiresIn = Math.min(Math.max(request.expiresIn, 60), 86_400);
    }
    if (request.webhookUrl) {
      body.webhook_url = request.webhookUrl;
    }

    // O objeto `customer` só vai se tiver conteúdo: enviar campos
    // vazios faz a API recusar por validação de formato.
    const c = request.customer;
    if (c) {
      const cliente: Record<string, string> = {};
      const nome = c.name?.trim();
      if (nome && nome.length >= 2) cliente.name = nome.slice(0, 100);

      const doc = (c.taxID ?? '').replace(/\D/g, '');
      if (doc.length === 11 || doc.length === 14) cliente.taxID = doc;

      if (c.email?.includes('@')) cliente.email = c.email.trim();

      const fone = (c.phone ?? '').replace(/\D/g, '');
      if (fone.length >= 10) cliente.phone = `+${fone}`;

      if (Object.keys(cliente).length > 0) body.customer = cliente;
    }

    const data = await this.call<{
      id?: string;
      correlationID?: string;
      correlationId?: string;
      qrCode?: string;
      qrCodeImage?: string;
      paymentLink?: string;
      expiresAt?: string;
      value?: number;
    }>('/api/charges', { method: 'POST', body: JSON.stringify(body) });

    const correlationId = data.correlationID ?? data.correlationId;
    if (!correlationId || !data.qrCode) {
      throw new PaymentError('Resposta da Dotfy sem código PIX', 502);
    }

    return {
      correlationId,
      externalId: data.id ?? null,
      qrCode: data.qrCode,
      qrCodeImage: data.qrCodeImage ?? null,
      paymentLink: data.paymentLink ?? null,
      // A resposta já vem em centavos. Não reconverter.
      amountCents: typeof data.value === 'number'
        ? data.value
        : request.amountCents,
      expiresAt: data.expiresAt ?? null,
    };
  }

  async getCharge(correlationId: string): Promise<{ status: string; paidAt: string | null }> {
    const data = await this.call<{ status?: string; paidAt?: string | null }>(
      `/api/charges/${encodeURIComponent(correlationId)}`
    );
    return {
      status: String(data.status ?? 'UNKNOWN').toUpperCase(),
      paidAt: data.paidAt ?? null,
    };
  }
}

/**
 * Verifica a assinatura do webhook.
 *
 * Formato documentado: `X-Webhook-Signature: t=<ms>,v1=<hex>`, onde o
 * HMAC-SHA256 é calculado sobre `timestamp + "." + body`.
 *
 * O corpo tem que ser o CRU. Reserializar o JSON reordena chaves e a
 * assinatura deixa de bater por um motivo que ninguém encontra
 * lendo o código.
 */
export function verifyDotfySignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  /** Janela de tolerância. Rejeita replay de eventos antigos. */
  toleranceMs = 5 * 60 * 1000
): boolean {
  if (!signatureHeader || !secret) return false;

  const partes = Object.fromEntries(
    signatureHeader
      .split(',')
      .map((p) => p.trim().split('='))
      .filter((p) => p.length === 2)
  ) as { t?: string; v1?: string };

  if (!partes.t || !partes.v1) return false;

  const timestamp = Number(partes.t);
  if (!Number.isFinite(timestamp)) return false;

  // Sem a janela, uma assinatura capturada uma vez valeria para
  // sempre — quem a interceptasse poderia reenviar "pagamento
  // confirmado" indefinidamente.
  if (Math.abs(Date.now() - timestamp) > toleranceMs) return false;

  const esperado = createHmac('sha256', secret)
    .update(`${partes.t}.${rawBody}`)
    .digest('hex');

  const recebido = partes.v1.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(recebido)) return false;

  const a = Buffer.from(esperado, 'hex');
  const b = Buffer.from(recebido, 'hex');
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

// ============================================================
// Chaves PIX estáticas
// ============================================================

export type PixKeyType = 'cpf' | 'cnpj' | 'email' | 'phone' | 'random';

/**
 * Valida e normaliza uma chave PIX conforme o tipo.
 *
 * A validação existe porque o erro aqui é silencioso e caro: uma
 * chave com um dígito trocado é copiada, enviada ao cliente, e só
 * aparece quando ele diz que o pagamento não foi. Nenhum sistema
 * avisa — o dinheiro simplesmente não chega.
 */
export function normalizePixKey(
  type: PixKeyType,
  value: string
): { ok: true; value: string } | { ok: false; error: string } {
  const bruto = (value ?? '').trim();
  if (!bruto) return { ok: false, error: 'Chave vazia' };

  switch (type) {
    case 'cpf': {
      const d = bruto.replace(/\D/g, '');
      if (d.length !== 11) return { ok: false, error: 'CPF deve ter 11 dígitos' };
      if (!isValidCpf(d)) return { ok: false, error: 'CPF inválido' };
      return { ok: true, value: d };
    }
    case 'cnpj': {
      const d = bruto.replace(/\D/g, '');
      if (d.length !== 14) return { ok: false, error: 'CNPJ deve ter 14 dígitos' };
      if (!isValidCnpj(d)) return { ok: false, error: 'CNPJ inválido' };
      return { ok: true, value: d };
    }
    case 'email': {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(bruto)) {
        return { ok: false, error: 'E-mail inválido' };
      }
      return { ok: true, value: bruto.toLowerCase() };
    }
    case 'phone': {
      const d = bruto.replace(/\D/g, '');
      // 10 (fixo) ou 11 (celular) dígitos; com 55 na frente, 12 ou 13.
      if (d.length < 10 || d.length > 13) {
        return { ok: false, error: 'Telefone inválido' };
      }
      const comPais = d.startsWith('55') && d.length >= 12 ? d : `55${d}`;
      return { ok: true, value: `+${comPais}` };
    }
    case 'random': {
      // Chave aleatória do BCB é um UUID v4.
      const v = bruto.toLowerCase();
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v)
      ) {
        return {
          ok: false,
          error: 'Chave aleatória deve ser o UUID gerado pelo seu banco',
        };
      }
      return { ok: true, value: v };
    }
  }
}

/** Formata para exibição. A chave crua é o que se copia. */
export function formatPixKey(type: PixKeyType, value: string): string {
  switch (type) {
    case 'cpf':
      return value.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    case 'cnpj':
      return value.replace(
        /(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,
        '$1.$2.$3/$4-$5'
      );
    default:
      return value;
  }
}

function isValidCpf(cpf: string): boolean {
  // Sequências repetidas passam no cálculo do dígito mas não são CPF.
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const digito = (base: string, pesoInicial: number): number => {
    let soma = 0;
    for (let i = 0; i < base.length; i += 1) {
      soma += Number(base[i]) * (pesoInicial - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return (
    digito(cpf.slice(0, 9), 10) === Number(cpf[9]) &&
    digito(cpf.slice(0, 10), 11) === Number(cpf[10])
  );
}

function isValidCnpj(cnpj: string): boolean {
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const digito = (base: string): number => {
    let peso = base.length - 7;
    let soma = 0;
    for (let i = 0; i < base.length; i += 1) {
      soma += Number(base[i]) * peso;
      peso -= 1;
      if (peso < 2) peso = 9;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  return (
    digito(cnpj.slice(0, 12)) === Number(cnpj[12]) &&
    digito(cnpj.slice(0, 13)) === Number(cnpj[13])
  );
}

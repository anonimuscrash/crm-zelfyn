// ============================================================
// Autenticação do webhook do serviço QR (§27).
//
// O endpoint recebe eventos de fora e grava mensagens no banco de um
// cliente. Sem verificação, qualquer um que descubra a URL injeta
// conversa na Inbox de qualquer workspace.
//
// ALGORITMO: SHA-512, NÃO SHA-256
// -------------------------------
// O WAHA assina com HMAC-SHA512 — está na documentação dele, e não é
// o padrão que a maioria dos provedores usa. Implementar SHA-256
// "porque é o comum" faz toda entrega ser rejeitada com 401, e o
// sintoma é silencioso: a sessão fica conectada, o webhook aparece
// registrado, e mensagem nenhuma chega.
//
// A assinatura é sobre o CORPO CRU. Sobre o corpo cru, não sobre o
// JSON reserializado: `JSON.parse` seguido de `JSON.stringify`
// reordena chaves e normaliza espaços, e a assinatura deixaria de
// bater por um motivo que ninguém encontra olhando o código.
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Algoritmo usado pelo WAHA. Confirmado na documentação oficial. */
const ALGORITMO = 'sha512';

export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature || !secret) return false;

  const esperado = createHmac(ALGORITMO, secret).update(rawBody).digest('hex');
  const recebido = signature
    .replace(/^sha(256|512)=/i, '')
    .trim()
    .toLowerCase();

  // Rejeita antes de chegar ao Buffer: uma string com caractere
  // não-hex vira bytes truncados silenciosamente, e a comparação
  // passaria a testar outra coisa.
  if (!/^[0-9a-f]+$/.test(recebido)) return false;

  const a = Buffer.from(esperado, 'hex');
  const b = Buffer.from(recebido, 'hex');

  // `timingSafeEqual` exige mesmo comprimento e lança se diferir.
  // Comparar o tamanho antes não vaza nada útil: o comprimento de um
  // HMAC-SHA512 é público e sempre 64 bytes.
  if (a.length !== b.length) return false;

  // Comparação em tempo constante: `===` sai no primeiro byte
  // diferente, e a diferença de tempo permite adivinhar a assinatura
  // byte a byte.
  return timingSafeEqual(a, b);
}

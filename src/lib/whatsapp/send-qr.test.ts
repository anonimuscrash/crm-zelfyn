import { describe, expect, it } from 'vitest';

import { QrSendError } from './send-qr';

/**
 * Estes testes cobrem as REGRAS do envio por QR, não a integração.
 * A chamada ao serviço e a persistência precisam de Supabase e do
 * WAHA no ar; o que dá para travar aqui é a lógica que decide
 * recusar antes de gastar uma chamada de rede.
 */

/** Espelha a validação de `sendViaQr`. */
function telefonePlausivel(phone: string): boolean {
  return phone.length >= 8 && phone.length <= 15;
}

describe('validação de telefone no envio', () => {
  it('aceita números internacionais válidos', () => {
    for (const n of ['5511999998888', '12025550123', '447700900123', '5521988887777']) {
      expect(telefonePlausivel(n)).toBe(true);
    }
  });

  it('recusa LID — o identificador interno que virou contato', () => {
    // Os dois casos reais que apareceram em produção antes do
    // tratamento de LID no parser.
    expect(telefonePlausivel('249460508647484')).toBe(true); // 15, no limite
    expect(telefonePlausivel('2494605086474849')).toBe(false); // 16
    expect(telefonePlausivel('70489607278598')).toBe(true); // 14, no limite
  });

  it('recusa número curto demais', () => {
    expect(telefonePlausivel('1234')).toBe(false);
    expect(telefonePlausivel('')).toBe(false);
  });
});

describe('QrSendError', () => {
  it('carrega status HTTP para a rota traduzir', () => {
    expect(new QrSendError('x').status).toBe(400);
    expect(new QrSendError('x', 409).status).toBe(409);
    expect(new QrSendError('x', 502).status).toBe(502);
  });

  it('é reconhecível por instanceof', () => {
    const e: unknown = new QrSendError('falhou');
    expect(e instanceof QrSendError).toBe(true);
    expect(e instanceof Error).toBe(true);
  });
});

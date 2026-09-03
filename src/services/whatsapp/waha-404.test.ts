import { describe, expect, it, vi, afterEach } from 'vitest';

import { WahaProvider } from './waha-provider';

/**
 * O 404 num POST não pode virar "enviado com sucesso".
 *
 * Este é o teste do bug do vídeo: o /api/sendVideo só existe no WAHA
 * Plus, e no Core responde 404. O `call` devolvia null para qualquer
 * 404, o extrator não achava id, e o código concluía "aceito, só não
 * li o id" — inventava um `local_...` e gravava como enviada. Nada
 * ia para o cliente e nenhum erro aparecia na tela.
 */

function provider() {
  return new WahaProvider({
    baseUrl: 'https://waha.exemplo',
    apiKey: 'k',
    webhookUrl: 'https://crm.exemplo/webhook',
    webhookSecret: 's',
  });
}

function respostaFake(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tratamento de 404 do WAHA', () => {
  it('recusa o envio quando o endpoint não existe, em vez de fingir sucesso', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respostaFake(404, { message: 'Cannot POST /api/sendVideo' })),
    );

    await expect(
      provider().sendMessage('sessao', {
        to: '5511999998888@c.us',
        type: 'video',
        mediaUrl: 'https://exemplo/video.mp4',
      }),
    ).rejects.toThrow(/não existe nesta instalação/i);
  });

  it('menciona o WAHA Plus, para o operador saber o que fazer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaFake(404, {})));

    await expect(
      provider().sendMessage('sessao', {
        to: '5511999998888@c.us',
        type: 'video',
        mediaUrl: 'https://exemplo/v.mp4',
      }),
    ).rejects.toThrow(/Plus/);
  });

  it('mantém 404 como "não existe" num GET, que é do que o createSession depende', async () => {
    const chamadas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        chamadas.push(`${init?.method ?? 'GET'} ${url}`);
        // Sessão não existe → 404 no GET; criação responde 201.
        if (!init?.method || init.method === 'GET') return respostaFake(404, {});
        return respostaFake(201, { name: 'sessao' });
      }),
    );

    // Não pode lançar: o 404 do GET significa "crie a sessão".
    await expect(provider().createSession('sessao')).resolves.toBeUndefined();
    expect(chamadas.some((c) => c.startsWith('POST'))).toBe(true);
  });

  it('habilita o store do NOWEB ao criar a sessão', async () => {
    let corpoCriacao: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === 'GET') return respostaFake(404, {});
        corpoCriacao = String(init.body ?? '');
        return respostaFake(201, { name: 'sessao' });
      }),
    );

    await provider().createSession('sessao');
    expect(corpoCriacao).toBeTruthy();
    const enviado = JSON.parse(corpoCriacao!);
    expect(enviado.config.noweb.store.enabled).toBe(true);
  });
});

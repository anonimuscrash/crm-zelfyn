import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

import {
  DEFAULT_BASE_URL,
  environmentFromKey,
  formatPixKey,
  isPublicHttpsUrl,
  isValidApiKey,
  normalizeE164,
  normalizePixKey,
  verifyDotfySignature,
} from './dotfy';

describe('environmentFromKey', () => {
  it('deriva o ambiente do prefixo da chave', () => {
    // A Dotfy não usa URLs diferentes — o ambiente está na
    // credencial. Derivar em vez de perguntar evita a conta marcada
    // como produção rodando com chave de teste.
    expect(environmentFromKey('vk_live_abc123')).toBe('production');
    expect(environmentFromKey('vk_test_abc123')).toBe('sandbox');
    expect(environmentFromKey('  vk_live_x  ')).toBe('production');
  });

  it('trata desconhecido como sandbox', () => {
    // O padrão seguro é o que NÃO move dinheiro real.
    expect(environmentFromKey('qualquer_coisa')).toBe('sandbox');
    expect(environmentFromKey('')).toBe('sandbox');
  });
});

describe('isValidApiKey', () => {
  it('aceita os dois prefixos documentados', () => {
    expect(isValidApiKey('vk_live_aBc123XyZ_890')).toBe(true);
    expect(isValidApiKey('vk_test_aBc123XyZ_890')).toBe(true);
  });

  it('recusa formatos que não são chave da Dotfy', () => {
    expect(isValidApiKey('sk_live_abc123def456')).toBe(false);
    expect(isValidApiKey('vk_live_curta')).toBe(false);
    expect(isValidApiKey('')).toBe(false);
  });
});

describe('normalizePixKey — CPF', () => {
  it('aceita CPF válido, com ou sem máscara', () => {
    const r1 = normalizePixKey('cpf', '529.982.247-25');
    expect(r1).toEqual({ ok: true, value: '52998224725' });
    expect(normalizePixKey('cpf', '52998224725')).toEqual({
      ok: true,
      value: '52998224725',
    });
  });

  it('recusa CPF com dígito verificador errado', () => {
    // Este é o erro caro: uma chave com um dígito trocado é copiada,
    // enviada ao cliente, e só aparece quando ele diz que pagou e o
    // dinheiro não chegou. Nenhum sistema avisa.
    const r = normalizePixKey('cpf', '52998224726');
    expect(r.ok).toBe(false);
  });

  it('recusa sequências repetidas', () => {
    // 111.111.111-11 passa no cálculo do dígito mas não é CPF.
    expect(normalizePixKey('cpf', '11111111111').ok).toBe(false);
    expect(normalizePixKey('cpf', '00000000000').ok).toBe(false);
  });

  it('recusa comprimento errado', () => {
    expect(normalizePixKey('cpf', '5299822472').ok).toBe(false);
    expect(normalizePixKey('cpf', '529982247251').ok).toBe(false);
  });
});

describe('normalizePixKey — CNPJ', () => {
  it('aceita CNPJ válido', () => {
    expect(normalizePixKey('cnpj', '11.222.333/0001-81')).toEqual({
      ok: true,
      value: '11222333000181',
    });
  });

  it('recusa dígito verificador errado', () => {
    expect(normalizePixKey('cnpj', '11222333000182').ok).toBe(false);
  });

  it('recusa sequências repetidas', () => {
    expect(normalizePixKey('cnpj', '11111111111111').ok).toBe(false);
  });
});

describe('normalizePixKey — e-mail', () => {
  it('aceita e normaliza para minúsculas', () => {
    expect(normalizePixKey('email', '  Vendas@Loja.COM.BR ')).toEqual({
      ok: true,
      value: 'vendas@loja.com.br',
    });
  });

  it('recusa formatos inválidos', () => {
    for (const v of ['sem-arroba', 'a@b', '@loja.com', 'a b@loja.com']) {
      expect(normalizePixKey('email', v).ok).toBe(false);
    }
  });
});

describe('normalizePixKey — telefone', () => {
  it('adiciona o código do país quando falta', () => {
    expect(normalizePixKey('phone', '11999998888')).toEqual({
      ok: true,
      value: '+5511999998888',
    });
  });

  it('não duplica o 55 quando já vem', () => {
    expect(normalizePixKey('phone', '5511999998888')).toEqual({
      ok: true,
      value: '+5511999998888',
    });
    expect(normalizePixKey('phone', '+55 (11) 99999-8888')).toEqual({
      ok: true,
      value: '+5511999998888',
    });
  });

  it('recusa comprimento implausível', () => {
    expect(normalizePixKey('phone', '999888').ok).toBe(false);
    expect(normalizePixKey('phone', '55119999988887777').ok).toBe(false);
  });
});

describe('normalizePixKey — aleatória', () => {
  it('aceita UUID v4', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    expect(normalizePixKey('random', uuid.toUpperCase())).toEqual({
      ok: true,
      value: uuid,
    });
  });

  it('recusa o que não é UUID v4', () => {
    // Chave aleatória do BCB é sempre UUID v4. Aceitar outra coisa
    // deixaria passar um texto qualquer como chave de recebimento.
    for (const v of [
      'chave-aleatoria',
      '123e4567-e89b-12d3-a456-426614174000',
      '123e4567e89b42d3a456426614174000',
    ]) {
      expect(normalizePixKey('random', v).ok).toBe(false);
    }
  });
});

describe('formatPixKey', () => {
  it('mascara CPF e CNPJ para leitura', () => {
    expect(formatPixKey('cpf', '52998224725')).toBe('529.982.247-25');
    expect(formatPixKey('cnpj', '11222333000181')).toBe('11.222.333/0001-81');
  });

  it('deixa os outros tipos intactos', () => {
    expect(formatPixKey('email', 'a@b.com')).toBe('a@b.com');
    expect(formatPixKey('phone', '+5511999998888')).toBe('+5511999998888');
  });
});

describe('verifyDotfySignature', () => {
  const secret = 'segredo-do-webhook';
  const body = '{"event":"EVENT:CHARGE_PAID","data":{"id":"c1"}}';

  const assinar = (ts: number) =>
    `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

  it('aceita assinatura válida e recente', () => {
    expect(verifyDotfySignature(body, assinar(Date.now()), secret)).toBe(true);
  });

  it('assina sobre timestamp + "." + corpo, como documentado', () => {
    const ts = Date.now();
    const errado = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyDotfySignature(body, `t=${ts},v1=${errado}`, secret)).toBe(false);
  });

  it('rejeita corpo adulterado', () => {
    const ts = Date.now();
    expect(
      verifyDotfySignature(body.replace('c1', 'c2'), assinar(ts), secret)
    ).toBe(false);
  });

  it('rejeita segredo diferente', () => {
    expect(verifyDotfySignature(body, assinar(Date.now()), 'outro')).toBe(false);
  });

  it('REJEITA evento antigo — proteção contra replay', () => {
    // Sem a janela, uma assinatura capturada uma vez valeria para
    // sempre: quem a interceptasse reenviaria "pagamento confirmado"
    // indefinidamente.
    const seisMinutos = Date.now() - 6 * 60 * 1000;
    expect(verifyDotfySignature(body, assinar(seisMinutos), secret)).toBe(false);
  });

  it('rejeita evento com data no futuro', () => {
    const futuro = Date.now() + 10 * 60 * 1000;
    expect(verifyDotfySignature(body, assinar(futuro), secret)).toBe(false);
  });

  it('rejeita cabeçalho malformado', () => {
    for (const h of [null, '', 'abc', 't=123', 'v1=abc', 't=xyz,v1=abc']) {
      expect(verifyDotfySignature(body, h, secret)).toBe(false);
    }
  });

  it('rejeita quando não há segredo configurado', () => {
    expect(verifyDotfySignature(body, assinar(Date.now()), '')).toBe(false);
  });
});

describe('DEFAULT_BASE_URL', () => {
  // A documentação mostra as rotas como caminho relativo
  // (`/api/charges`), sem host. Supus `api.dotfy.com.br` e ele nem
  // resolve — o fetch falhava sem resposta e a tela dizia "serviço
  // indisponível", que parece problema do fornecedor.
  //
  // Verificado contra os dois hosts: api.* não conecta, app.*
  // responde 403 a uma chave falsa, ou seja, o servidor está lá.
  it('aponta para o host que responde', () => {
    expect(DEFAULT_BASE_URL).toBe('https://app.dotfy.com.br');
  });

  it('não termina em barra — as rotas já começam com uma', () => {
    expect(DEFAULT_BASE_URL.endsWith('/')).toBe(false);
  });
});

describe('normalizeE164', () => {
  it('completa o país em número nacional', () => {
    expect(normalizeE164('11999998888')).toBe('+5511999998888');
    expect(normalizeE164('(11) 3333-4444')).toBe('+551133334444');
  });

  it('não duplica o 55 quando já vem', () => {
    expect(normalizeE164('5511999998888')).toBe('+5511999998888');
    expect(normalizeE164('+55 11 99999-8888')).toBe('+5511999998888');
  });

  it('RECUSA o LID do WhatsApp', () => {
    // Checar só o PREFIXO era um furo: `1` é o código dos EUA, e
    // qualquer identificador começando com 1 passava. Foi assim que
    // `167843412844796` virou telefone e derrubou a cobrança.
    expect(normalizeE164('167843412844796')).toBeNull();
    // Contatos criados a partir de LID guardam um identificador
    // interno de 15 dígitos na coluna `phone`. Mandá-lo com `+` na
    // frente derrubava a cobrança inteira por causa de um campo
    // opcional — o operador ficava sem cobrar por um dado que nem
    // precisava ir.
    expect(normalizeE164('249460508647484')).toBeNull();
    expect(normalizeE164('70489607278598')).toBeNull();
  });

  it('recusa vazio e lixo', () => {
    for (const v of ['', null, undefined, 'abc', '123']) {
      expect(normalizeE164(v)).toBeNull();
    }
  });

  it('aceita internacional com comprimento correto do país', () => {
    expect(normalizeE164('351912345678')).toBe('+351912345678');
    expect(normalizeE164('4471234567890')).toBe('+4471234567890');
  });

  it('recusa número do comprimento errado para o país', () => {
    // Prefixo certo não basta: `1` seguido de 14 dígitos não é um
    // número dos EUA, é um identificador.
    expect(normalizeE164('1234567890123456')).toBeNull();
    expect(normalizeE164('3519123456789012')).toBeNull();
  });

  it('prioriza a regra brasileira em número de 11 dígitos', () => {
    // `12025550123` tem 11 dígitos e é ambíguo: pode ser um número
    // dos EUA (+1 202...) ou um celular brasileiro sem o país.
    //
    // Num CRM brasileiro, a segunda leitura acerta muito mais vezes.
    // Assumir internacional faria todo celular com DDD 12, 13 ou 14
    // — Vale do Paraíba e litoral paulista — sair errado.
    expect(normalizeE164('12025550123')).toBe('+5512025550123');
  });
});

describe('isPublicHttpsUrl', () => {
  it('aceita domínio público em https', () => {
    expect(isPublicHttpsUrl('https://crm.exemplo.com.br/webhook')).toBe(true);
  });

  it('recusa loopback e localhost', () => {
    // `request.url` dentro de um container aponta para cá, e a Dotfy
    // recusa — corretamente: um endereço que só existe na nossa rede
    // nunca receberia o evento.
    expect(isPublicHttpsUrl('https://localhost:3000/webhook')).toBe(false);
    expect(isPublicHttpsUrl('https://127.0.0.1/webhook')).toBe(false);
  });

  it('recusa faixas de IP privado', () => {
    for (const ip of ['10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.1.1']) {
      expect(isPublicHttpsUrl(`https://${ip}/webhook`)).toBe(false);
    }
  });

  it('aceita IP público', () => {
    expect(isPublicHttpsUrl('https://172.15.0.1/webhook')).toBe(true);
    expect(isPublicHttpsUrl('https://8.8.8.8/webhook')).toBe(true);
  });

  it('recusa http sem TLS', () => {
    expect(isPublicHttpsUrl('http://exemplo.com.br/webhook')).toBe(false);
  });

  it('recusa nome de container — sem ponto não é domínio', () => {
    expect(isPublicHttpsUrl('https://operza-web/webhook')).toBe(false);
  });

  it('recusa URL malformada', () => {
    expect(isPublicHttpsUrl('nao-e-url')).toBe(false);
    expect(isPublicHttpsUrl('')).toBe(false);
  });
});

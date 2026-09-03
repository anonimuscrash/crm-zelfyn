// ============================================================
// Fábrica de providers.
//
// Único lugar do projeto que decide qual adapter atende uma
// conexão. Rotas e componentes pedem por `providerFor(conexao)` e
// recebem o contrato — nunca importam `WahaProvider` diretamente.
//
// As variáveis de ambiente do serviço QR são lidas AQUI e em mais
// lugar nenhum. Se amanhã o WAHA for trocado por outro serviço,
// muda este arquivo e o adapter; o resto do projeto não percebe.
// ============================================================

import { ProviderError, type WhatsAppProvider } from './types';
import { WahaProvider } from './waha-provider';

export * from './types';
export { WahaProvider } from './waha-provider';

/** Identificador da sessão no serviço, derivado do id da conexão.
 *
 *  Derivado e não aleatório para ser reconstruível; prefixado para
 *  não colidir com sessões que outra aplicação tenha criado no mesmo
 *  serviço. Nunca aceito do cliente — um identificador escolhido por
 *  quem chama deixaria um workspace apontar para a sessão de outro.
 */
export function instanceIdFor(connectionId: string): string {
  return `operza_${connectionId.replace(/-/g, '')}`;
}

let cache: WahaProvider | null = null;

/**
 * Provider do QR, ou `null` quando o serviço não foi configurado.
 *
 * Retorna `null` em vez de lançar: a tela de configuração precisa
 * conseguir dizer "o modo QR não está disponível nesta instalação"
 * sem quebrar, e um deploy sem o serviço QR é uma escolha legítima
 * de quem só usa a API oficial.
 */
export function getQrProvider(): WhatsAppProvider | null {
  const baseUrl = process.env.WAHA_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  const webhookUrl = process.env.WAHA_WEBHOOK_URL;
  const webhookSecret = process.env.WAHA_WEBHOOK_SECRET;

  if (!baseUrl || !apiKey || !webhookUrl || !webhookSecret) {
    return null;
  }

  if (!cache) {
    cache = new WahaProvider({
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey,
      webhookUrl,
      webhookSecret,
    });
  }

  return cache;
}

export function requireQrProvider(): WhatsAppProvider {
  const p = getQrProvider();
  if (!p) {
    throw new ProviderError(
      'Conexão por QR não está configurada nesta instalação',
      503
    );
  }
  return p;
}

/** O modo QR está disponível? Consumido pela tela de configuração. */
export function qrModeAvailable(): boolean {
  return getQrProvider() !== null;
}

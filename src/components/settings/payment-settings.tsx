'use client';

// ============================================================
// Configurações → Pagamentos.
//
// Mesma postura das outras integrações: só master, credencial nunca
// volta ao navegador, e a tela confirma QUAL chave está em uso pelos
// últimos quatro caracteres.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, KeyRound, Loader2, Plus, Trash2, Zap } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { commerceMutate } from '@/hooks/use-commerce';
import { useSessionContext } from '@/hooks/use-session-context';
import { canManageIntegrations } from '@/lib/auth/permissions';
import { ErrorState, Skeleton } from '@/components/commerce/primitives';
import { formatPixKey, type PixKeyType } from '@/services/payments/dotfy';

interface Config {
  is_enabled: boolean;
  webhook_enabled: boolean;
  base_url: string | null;
  environment: 'sandbox' | 'production';
  api_key_hint: string | null;
  default_expires_in: number;
}

interface PixKey {
  id: string;
  label: string;
  key_type: PixKeyType;
  key_value: string;
  holder_name: string | null;
  is_default: boolean;
}

const TIPOS: PixKeyType[] = ['cpf', 'cnpj', 'email', 'phone', 'random'];

export function PaymentSettings() {
  const t = useTranslations('Payments');
  const tc = useTranslations('Commerce');
  const { context } = useSessionContext();

  const [config, setConfig] = useState<Config | null>(null);
  const [chaves, setChaves] = useState<PixKey[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [testando, setTestando] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [segredo, setSegredo] = useState('');
  const [copiado, setCopiado] = useState(false);

  // Nova chave
  const [novaLabel, setNovaLabel] = useState('');
  const [novoTipo, setNovoTipo] = useState<PixKeyType>('random');
  const [novoValor, setNovoValor] = useState('');
  const [novoTitular, setNovoTitular] = useState('');

  const podeGerenciar = canManageIntegrations(context);

  const carregar = useCallback(async () => {
    try {
      const [c, k] = await Promise.all([
        fetch('/api/payments/settings').then(async (r) => {
          if (!r.ok) {
            const b = (await r.json().catch(() => null)) as { error?: string } | null;
            throw new Error(b?.error ?? tc('loadError'));
          }
          return r.json() as Promise<Config>;
        }),
        fetch('/api/payments/pix-keys').then((r) => (r.ok ? r.json() : null)),
      ]);
      setConfig(c);
      setChaves(k?.keys ?? []);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : tc('loadError'));
    } finally {
      setCarregando(false);
    }
  }, [tc]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function salvar(patch: Record<string, unknown>) {
    setSalvando(true);
    try {
      const res = await fetch('/api/payments/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json = (await res.json()) as Config & {
        error?: string;
        warning?: string | null;
      };
      if (!res.ok) throw new Error(json.error ?? tc('loadError'));
      setConfig(json);

      // O salvamento não depende mais da validação contra a Dotfy.
      // Quando o teste falha, a configuração é gravada e o motivo
      // aparece — em vez de travar o operador sem saída.
      if (json.warning) {
        toast.warning(json.warning, { duration: 8000 });
        setApiKey('');
        setSegredo('');
        setSalvando(false);
        return;
      }
      // Limpa os campos de segredo: mantê-los preenchidos sugeriria
      // que o valor visível é o guardado, e ele nunca é.
      setApiKey('');
      setSegredo('');
      toast.success(tc('saved'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc('loadError'));
    } finally {
      setSalvando(false);
    }
  }

  async function testar() {
    setTestando(true);
    try {
      const res = await fetch('/api/payments/settings', { method: 'POST' });
      const json = (await res.json()) as { error?: string; seller?: string | null };
      if (!res.ok) throw new Error(json.error ?? tc('loadError'));
      // Mostra o nome do seller quando a Dotfy informa: confirma que
      // é a conta certa, não só que a chave é válida.
      toast.success(
        json.seller ? t('keyValidSeller', { seller: json.seller }) : t('keyValid')
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc('loadError'));
    } finally {
      setTestando(false);
    }
  }

  async function adicionarChave() {
    if (!novaLabel.trim() || !novoValor.trim()) return;
    setSalvando(true);
    try {
      const nova = await commerceMutate<PixKey>(
        '/api/payments/pix-keys',
        'POST',
        {
          label: novaLabel,
          key_type: novoTipo,
          key_value: novoValor,
          holder_name: novoTitular || null,
          is_default: chaves.length === 0,
        }
      );
      toast.success(t('keyAdded'));
      setChaves([...chaves, nova]);
      setNovaLabel('');
      setNovoValor('');
      setNovoTitular('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc('loadError'));
    } finally {
      setSalvando(false);
    }
  }

  async function removerChave(id: string) {
    if (!window.confirm(t('confirmRemoveKey'))) return;
    try {
      await commerceMutate(`/api/payments/pix-keys/${id}`, 'DELETE');
      toast.success(t('keyRemoved'));
      setChaves(chaves.filter((k) => k.id !== id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc('loadError'));
    }
  }

  const urlWebhook =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/integrations/dotfy/webhook`
      : '';

  if (carregando) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  if (erro) return <ErrorState message={erro} onRetry={carregar} />;
  if (!config) return null;

  if (!podeGerenciar) {
    return (
      <p className="rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground">
        {t('masterOnly')}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Zap className="h-4 w-4" />
          {t('settingsTitle')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('settingsSubtitle')}
        </p>
      </div>

      {/* ---- Dotfy ---- */}
      <section className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {t('dotfyTitle')}
          </h3>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {t('dotfySubtitle')}
          </p>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={config.is_enabled}
            onChange={(e) => salvar({ is_enabled: e.target.checked })}
            disabled={salvando}
            className="h-4 w-4 rounded border-border accent-[var(--primary)]"
          />
          {t('enableDotfy')}
        </label>

        <div>
          <Label htmlFor="dotfy-key" className="text-xs text-muted-foreground">
            {t('apiKey')}
          </Label>
          {config.api_key_hint ? (
            <p className="mb-1 text-[11px] text-muted-foreground">
              {t('apiKeySaved')}: ••••••••{config.api_key_hint}
              <span
                className={cn(
                  'ml-2 rounded border px-1.5 py-0.5 text-[10px]',
                  config.environment === 'production'
                    ? 'border-emerald-600/25 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400'
                    : 'border-amber-600/25 bg-amber-600/10 text-amber-700 dark:text-amber-400'
                )}
              >
                {t(config.environment)}
              </span>
            </p>
          ) : null}
          <Input
            id="dotfy-key"
            type="password"
            value={apiKey}
            placeholder="vk_live_… ou vk_test_…"
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && apiKey.trim()) salvar({ api_key: apiKey });
            }}
            className="mt-1 h-9 font-mono text-xs"
          />
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t('apiKeyHelp')}
          </p>
          {config.environment === 'sandbox' && config.api_key_hint ? (
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
              {t('sandboxWarning')}
            </p>
          ) : null}
        </div>

        {/* Endereço da API.
            Só aparece depois que há chave salva: antes disso o
            operador não tem como saber se precisa mexer, e um campo
            avançado no meio do cadastro inicial vira dúvida. */}
        {config.api_key_hint ? (
          <div>
            <Label htmlFor="dotfy-base" className="text-xs text-muted-foreground">
              {t('baseUrl')}
            </Label>
            <Input
              id="dotfy-base"
              defaultValue={config.base_url ?? ''}
              placeholder="https://app.dotfy.com.br"
              onBlur={(e) =>
                e.target.value.trim().replace(/\/+$/, '') !==
                  (config.base_url ?? '') && salvar({ base_url: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              className="mt-1 h-9 font-mono text-xs"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t('baseUrlHelp')}
            </p>
          </div>
        ) : null}

        <div className="border-t border-border pt-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={config.webhook_enabled}
              onChange={(e) => salvar({ webhook_enabled: e.target.checked })}
              disabled={salvando}
              className="h-4 w-4 rounded border-border accent-[var(--primary)]"
            />
            {t('autoConfirm')}
          </label>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t('autoConfirmHelp')}
          </p>
        </div>

        {/* Segredo e URL só aparecem quando a confirmação automática
            está ligada. Campos de um recurso desligado são ruído — e
            sugerem pendência onde há uma escolha. */}
        {config.webhook_enabled ? (
          <>
        <div>
          <Label htmlFor="dotfy-secret" className="text-xs text-muted-foreground">
            {t('webhookSecret')}
          </Label>
          <Input
            id="dotfy-secret"
            type="password"
            value={segredo}
            onChange={(e) => setSegredo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && segredo.trim()) {
                salvar({ webhook_secret: segredo });
              }
            }}
            className="mt-1 h-9 font-mono text-xs"
          />
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t('webhookSecretHelp')}
          </p>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">
            {t('webhookUrl')}
          </Label>
          <div className="mt-1 flex gap-1.5">
            <Input
              readOnly
              value={urlWebhook}
              className="h-9 flex-1 font-mono text-[11px]"
            />
            <Button
              size="sm"
              variant="secondary"
              className="h-9 shrink-0"
              onClick={async () => {
                await navigator.clipboard.writeText(urlWebhook);
                setCopiado(true);
                setTimeout(() => setCopiado(false), 2000);
              }}
            >
              {copiado ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t('webhookUrlHelp')}
          </p>
        </div>
        </>
        ) : null}

        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="dotfy-exp" className="text-xs text-muted-foreground">
              {t('expiresIn')}
            </Label>
            <Input
              id="dotfy-exp"
              type="number"
              min={60}
              max={86400}
              defaultValue={config.default_expires_in}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (n !== config.default_expires_in) {
                  salvar({ default_expires_in: n });
                }
              }}
              className="mt-1 h-9 w-32 tabular-nums"
            />
          </div>

          {apiKey.trim() ? (
            <Button
              size="sm"
              className="h-9"
              onClick={() => salvar({ api_key: apiKey })}
              disabled={salvando}
            >
              {salvando ? tc('saving') : tc('save')}
            </Button>
          ) : config.api_key_hint ? (
            <Button
              size="sm"
              variant="secondary"
              className="h-9"
              onClick={testar}
              disabled={testando}
            >
              {testando ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t('testKey')}
            </Button>
          ) : null}

          {segredo.trim() ? (
            <Button
              size="sm"
              className="h-9"
              onClick={() => salvar({ webhook_secret: segredo })}
              disabled={salvando}
            >
              {tc('save')}
            </Button>
          ) : null}
        </div>
      </section>

      {/* ---- Chaves PIX ---- */}
      <section className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <KeyRound className="h-3.5 w-3.5" />
            {t('pixKeysTitle')}
          </h3>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {t('pixKeysSubtitle')}
          </p>
        </div>

        {chaves.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('noKeys')}</p>
        ) : (
          <ul className="space-y-1.5">
            {chaves.map((k) => (
              <li
                key={k.id}
                className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-foreground">
                      {k.label}
                    </span>
                    {k.is_default ? (
                      <span className="shrink-0 rounded border border-border px-1 py-0.5 text-[9px] text-muted-foreground">
                        {t('isDefault')}
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-[11px] tabular-nums text-muted-foreground">
                    {formatPixKey(k.key_type, k.key_value)}
                  </span>
                </span>

                {!k.is_default ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 shrink-0 text-[11px]"
                    onClick={async () => {
                      await commerceMutate(
                        `/api/payments/pix-keys/${k.id}`,
                        'PATCH',
                        { is_default: true }
                      );
                      void carregar();
                    }}
                  >
                    {t('setDefault')}
                  </Button>
                ) : null}

                <button
                  type="button"
                  onClick={() => removerChave(k.id)}
                  aria-label={t('removeKey')}
                  className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2 border-t border-border pt-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <Label className="text-xs text-muted-foreground">
                {t('keyLabel')}
              </Label>
              <Input
                value={novaLabel}
                placeholder={t('keyLabelPlaceholder')}
                onChange={(e) => setNovaLabel(e.target.value)}
                className="mt-1 h-9"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">
                {t('keyType')}
              </Label>
              <select
                value={novoTipo}
                onChange={(e) => setNovoTipo(e.target.value as PixKeyType)}
                className="mt-1 h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground"
              >
                {TIPOS.map((tp) => (
                  <option key={tp} value={tp}>
                    {t(`type${tp.charAt(0).toUpperCase()}${tp.slice(1)}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <Label className="text-xs text-muted-foreground">
                {t('keyValue')}
              </Label>
              <Input
                value={novoValor}
                onChange={(e) => setNovoValor(e.target.value)}
                className="mt-1 h-9 tabular-nums"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">
                {t('holderName')}
              </Label>
              <Input
                value={novoTitular}
                onChange={(e) => setNovoTitular(e.target.value)}
                className="mt-1 h-9"
              />
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground">
            {t('holderNameHelp')}
          </p>

          <Button
            size="sm"
            onClick={adicionarChave}
            disabled={salvando || !novaLabel.trim() || !novoValor.trim()}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('addKey')}
          </Button>
        </div>
      </section>
    </div>
  );
}

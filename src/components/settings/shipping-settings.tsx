'use client';

// ============================================================
// Configurações → Frete (SuperFrete).
//
// Mesma postura da configuração de WhatsApp: só master, credencial
// nunca volta ao navegador, e a tela confirma QUAL token está em uso
// pelos últimos quatro caracteres — suficiente para reconhecer,
// insuficiente para usar.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Truck } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useSessionContext } from '@/hooks/use-session-context';
import { canManageIntegrations } from '@/lib/auth/permissions';
import { ErrorState, Skeleton } from '@/components/commerce/primitives';
import { IntegrationLogo } from '@/components/brand/integration-logo';

interface Config {
  is_enabled: boolean;
  environment: 'sandbox' | 'production';
  token_hint: string | null;
  contact_email: string | null;
  origin_postal_code: string | null;
  default_height_cm: number;
  default_width_cm: number;
  default_length_cm: number;
  default_weight_kg: number;
  services: string | null;
}

export function ShippingSettings() {
  const t = useTranslations('Shipping');
  const tc = useTranslations('Commerce');
  const { context } = useSessionContext();

  const [config, setConfig] = useState<Config | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [token, setToken] = useState('');

  const podeGerenciar = canManageIntegrations(context);

  const carregar = useCallback(async () => {
    try {
      const res = await fetch('/api/shipping/settings');
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error ?? tc('loadError'));
      }
      setConfig((await res.json()) as Config);
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

  async function salvar(patch: Partial<Config> & { token?: string }) {
    setSalvando(true);
    try {
      const res = await fetch('/api/shipping/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json = (await res.json()) as Config & { error?: string };
      if (!res.ok) throw new Error(json.error ?? tc('loadError'));
      setConfig(json);
      // O campo de token é limpo após salvar: mantê-lo preenchido
      // sugeriria que o valor visível é o que está guardado, e ele
      // nunca é — o servidor não devolve credencial.
      setToken('');
      toast.success(t('saved'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc('loadError'));
    } finally {
      setSalvando(false);
    }
  }

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
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <IntegrationLogo
            name="superfrete"
            themed
            size={18}
            fallback={<Truck className="h-4 w-4" />}
          />
          {t('settingsTitle')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('settingsSubtitle')}
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
        {t('enable')}
      </label>

      <section className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div>
          <Label htmlFor="sf-token" className="text-xs text-muted-foreground">
            {t('token')}
          </Label>
          {config.token_hint ? (
            <p className="mb-1 text-[11px] text-muted-foreground">
              {t('tokenSaved')}: ••••••••{config.token_hint}
            </p>
          ) : null}
          <Input
            id="sf-token"
            type="password"
            value={token}
            placeholder={t('tokenPlaceholder')}
            onChange={(e) => setToken(e.target.value)}
            className="mt-1 h-9 font-mono text-xs"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t('tokenHelp')}
          </p>
        </div>

        <div>
          <Label htmlFor="sf-email" className="text-xs text-muted-foreground">
            {t('contactEmail')}
          </Label>
          <Input
            id="sf-email"
            type="email"
            defaultValue={config.contact_email ?? ''}
            onBlur={(e) =>
              e.target.value !== (config.contact_email ?? '') &&
              salvar({ contact_email: e.target.value })
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            className="mt-1 h-9"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t('contactEmailHelp')}
          </p>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">
            {t('environment')}
          </Label>
          <div className="mt-1 inline-flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            {(['sandbox', 'production'] as const).map((amb) => (
              <button
                key={amb}
                type="button"
                onClick={() => salvar({ environment: amb })}
                disabled={salvando}
                aria-pressed={config.environment === amb}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                  config.environment === amb
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {t(amb)}
              </button>
            ))}
          </div>
          {config.environment === 'sandbox' ? (
            <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400">
              {t('sandboxWarning')}
            </p>
          ) : null}
        </div>

        {token.trim() ? (
          <Button
            size="sm"
            onClick={() => salvar({ token })}
            disabled={salvando}
          >
            {salvando ? tc('saving') : tc('save')}
          </Button>
        ) : null}
      </section>

      <section className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div>
          <Label htmlFor="sf-origin" className="text-xs text-muted-foreground">
            {t('origin')}
          </Label>
          <Input
            id="sf-origin"
            defaultValue={config.origin_postal_code ?? ''}
            placeholder="00000000"
            inputMode="numeric"
            maxLength={9}
            onBlur={(e) =>
              e.target.value.replace(/\D/g, '') !==
                (config.origin_postal_code ?? '') &&
              salvar({ origin_postal_code: e.target.value })
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            className="mt-1 h-9 w-40 tabular-nums"
          />
        </div>

        <div>
          <Label htmlFor="sf-services" className="text-xs text-muted-foreground">
            {t('services')}
          </Label>
          {/* Salva no blur E no Enter.
              Salvar só no blur é uma armadilha real: o operador
              digita, olha a tela achando que salvou, e o valor nunca
              chega ao banco. Aconteceu aqui — a cotação voltava com
              uma transportadora só porque o campo continuava em
              foco. */}
          <Input
            id="sf-services"
            defaultValue={config.services ?? ''}
            placeholder="1,2,17"
            onBlur={(e) =>
              e.target.value.trim().replace(/\s+/g, '') !==
                (config.services ?? '') &&
              salvar({ services: e.target.value })
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            className="mt-1 h-9 w-48 tabular-nums"
          />
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t('servicesHelp')}
          </p>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">
            {t('defaultPackage')}
          </Label>
          <p className="mb-2 text-[11px] text-muted-foreground">
            {t('defaultPackageHelp')}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Medida
              rotulo={t('height')}
              valor={config.default_height_cm}
              onSalvar={(v) => salvar({ default_height_cm: v })}
            />
            <Medida
              rotulo={t('width')}
              valor={config.default_width_cm}
              onSalvar={(v) => salvar({ default_width_cm: v })}
            />
            <Medida
              rotulo={t('length')}
              valor={config.default_length_cm}
              onSalvar={(v) => salvar({ default_length_cm: v })}
            />
            <Medida
              rotulo={t('weight')}
              valor={config.default_weight_kg}
              onSalvar={(v) => salvar({ default_weight_kg: v })}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function Medida({
  rotulo,
  valor,
  onSalvar,
}: {
  rotulo: string;
  valor: number;
  onSalvar: (v: number) => void;
}) {
  return (
    <div>
      <Label className="text-[10px] text-muted-foreground">{rotulo}</Label>
      <Input
        type="number"
        step="0.1"
        min="0"
        defaultValue={valor}
        onBlur={(e) => {
          const n = Number(e.target.value.replace(',', '.'));
          if (Number.isFinite(n) && n > 0 && n !== valor) onSalvar(n);
        }}
        className="mt-0.5 h-8 tabular-nums"
      />
    </div>
  );
}

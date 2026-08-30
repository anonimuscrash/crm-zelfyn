'use client';

// ============================================================
// Configurações → WhatsApp (§2, §3, §36).
//
// A tela mostra ESTADO, nunca infraestrutura: sem JSON, sem id de
// instância, sem endpoint, sem token. O operador só precisa saber se
// está conectado e o que fazer quando não está.
//
// O polling é adaptativo. Enquanto um QR está na tela, 3 segundos —
// o código vale menos de um minuto e o usuário precisa ver a
// conexão acontecer sem apertar nada. Conectado, 30 segundos, só
// para perceber uma queda. Um intervalo fixo curto martelaria o
// serviço QR sem motivo pelo resto do dia.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  Plus,
  QrCode,
  RefreshCw,
  Smartphone,
  Trash2,
  Unplug,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { commerceMutate } from '@/hooks/use-commerce';
import { useSessionContext } from '@/hooks/use-session-context';
import { canManageIntegrations } from '@/lib/auth/permissions';
import { IntegrationLogo } from '@/components/brand/integration-logo';
import {
  EmptyState,
  ErrorState,
  formatDateTimeBR,
  Skeleton,
} from '@/components/commerce/primitives';

type Status =
  | 'disconnected'
  | 'connecting'
  | 'qr_required'
  | 'qr_expired'
  | 'connected'
  | 'logged_out'
  | 'failed';

interface Conexao {
  id: string;
  provider: 'meta_cloud' | 'qr';
  name: string;
  phone_number: string | null;
  display_name: string | null;
  status: Status;
  last_seen_at: string | null;
  last_connected_at: string | null;
  restricted: boolean;
  member_count: number;
}

const STATUS_META: Record<Status, { key: string; dot: string; chip: string }> = {
  disconnected: {
    key: 'statusDisconnected',
    dot: 'bg-slate-400',
    chip: 'border-border bg-muted text-muted-foreground',
  },
  connecting: {
    key: 'statusConnecting',
    dot: 'bg-amber-500 animate-pulse',
    chip: 'border-amber-600/25 bg-amber-600/10 text-amber-700 dark:text-amber-400',
  },
  qr_required: {
    key: 'statusQrRequired',
    dot: 'bg-primary animate-pulse',
    chip: 'border-primary/25 bg-primary/10 text-primary',
  },
  qr_expired: {
    key: 'statusQrExpired',
    dot: 'bg-amber-500',
    chip: 'border-amber-600/25 bg-amber-600/10 text-amber-700 dark:text-amber-400',
  },
  connected: {
    key: 'statusConnected',
    dot: 'bg-emerald-600',
    chip: 'border-emerald-600/25 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
  },
  logged_out: {
    key: 'statusLoggedOut',
    dot: 'bg-red-500',
    chip: 'border-red-600/25 bg-red-600/8 text-red-700 dark:text-red-400',
  },
  failed: {
    key: 'statusFailed',
    dot: 'bg-red-500',
    chip: 'border-red-600/25 bg-red-600/8 text-red-700 dark:text-red-400',
  },
};

export function WhatsAppConnectionSettings() {
  const t = useTranslations('WhatsApp');
  const tc = useTranslations('Commerce');
  const { context } = useSessionContext();

  const [conexoes, setConexoes] = useState<Conexao[]>([]);
  const [qrAvailable, setQrAvailable] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);
  const [nome, setNome] = useState('');
  const [ativa, setAtiva] = useState<string | null>(null);

  const podeGerenciar = canManageIntegrations(context);

  const carregar = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/connections');
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error ?? tc('loadError'));
      }
      const json = (await res.json()) as {
        connections: Conexao[];
        qrAvailable: boolean;
      };
      setConexoes(json.connections);
      setQrAvailable(json.qrAvailable);
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

  async function criar() {
    if (!nome.trim()) return;
    setCriando(true);
    try {
      const nova = await commerceMutate<{ id: string }>(
        '/api/whatsapp/connections',
        'POST',
        { name: nome.trim(), provider: 'qr' }
      );
      toast.success(t('connectionCreated'));
      setNome('');
      await carregar();
      setAtiva(nova.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc('loadError'));
    } finally {
      setCriando(false);
    }
  }

  if (carregando) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }

  if (erro) return <ErrorState message={erro} onRetry={carregar} />;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <IntegrationLogo
            name="whatsapp"
            size={18}
            fallback={<Smartphone className="h-4 w-4" />}
          />
          {t('title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {!podeGerenciar ? (
        <p className="rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground">
          {t('masterOnly')}
        </p>
      ) : null}

      {conexoes.length === 0 ? (
        <EmptyState
          icon={<Smartphone className="h-6 w-6" />}
          title={t('emptyTitle')}
          description={t('emptyBody')}
        />
      ) : (
        <ul className="space-y-3">
          {conexoes.map((c) => (
            <ConnectionCard
              key={c.id}
              connection={c}
              expanded={ativa === c.id}
              canManage={podeGerenciar}
              onToggle={() => setAtiva(ativa === c.id ? null : c.id)}
              onChanged={carregar}
            />
          ))}
        </ul>
      )}

      {podeGerenciar ? (
        <section className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-medium text-foreground">
            {t('methodQr')}
          </h3>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {t('methodQrHint')}
          </p>

          {!qrAvailable ? (
            <p className="mt-3 rounded-lg border border-amber-600/25 bg-amber-600/5 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-400">
              {t('qrUnavailable')}
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="min-w-[200px] flex-1">
                <Label htmlFor="conn-name" className="text-xs text-muted-foreground">
                  {t('connectionName')}
                </Label>
                <Input
                  id="conn-name"
                  value={nome}
                  placeholder={t('connectionNamePlaceholder')}
                  onChange={(e) => setNome(e.target.value)}
                  className="mt-1 h-9"
                />
              </div>
              <Button
                size="sm"
                className="h-9"
                onClick={criar}
                disabled={criando || !nome.trim()}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                {criando ? tc('saving') : t('addConnection')}
              </Button>
            </div>
          )}

          {/* Transparência técnica sem alarmismo (§36). */}
          <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
            {t('qrDisclosure')}
          </p>
        </section>
      ) : null}
    </div>
  );
}

function ConnectionCard({
  connection,
  expanded,
  canManage,
  onToggle,
  onChanged,
}: {
  connection: Conexao;
  expanded: boolean;
  canManage: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('WhatsApp');
  const tc = useTranslations('Commerce');

  const [status, setStatus] = useState<Status>(connection.status);
  const [qr, setQr] = useState<string | null>(null);
  const [phone, setPhone] = useState(connection.phone_number);
  const [buscando, setBuscando] = useState(false);
  const [agindo, setAgindo] = useState(false);

  const meta = STATUS_META[status] ?? STATUS_META.failed;

  const consultar = useCallback(async () => {
    setBuscando(true);
    try {
      const res = await fetch(`/api/whatsapp/connections/${connection.id}`);
      if (!res.ok) return;
      const json = (await res.json()) as {
        connection: { status: Status; phone_number: string | null };
        qr: { dataUrl: string } | null;
      };
      setStatus(json.connection.status);
      setPhone(json.connection.phone_number);
      setQr(json.qr?.dataUrl ?? null);
    } finally {
      setBuscando(false);
    }
  }, [connection.id]);

  // Polling adaptativo: rápido só enquanto há um QR na tela.
  const intervalo = useMemo(() => {
    if (!expanded || connection.provider !== 'qr') return null;
    if (status === 'qr_required' || status === 'connecting') return 3_000;
    if (status === 'connected') return 30_000;
    return 10_000;
  }, [expanded, connection.provider, status]);

  useEffect(() => {
    if (!expanded || connection.provider !== 'qr') return;
    void consultar();
  }, [expanded, connection.provider, consultar]);

  useEffect(() => {
    if (intervalo === null) return;
    const id = setInterval(() => void consultar(), intervalo);
    return () => clearInterval(id);
  }, [intervalo, consultar]);

  async function acao(action: 'connect' | 'disconnect' | 'restart') {
    setAgindo(true);
    try {
      await commerceMutate(`/api/whatsapp/connections/${connection.id}`, 'PATCH', {
        action,
      });
      if (action === 'disconnect') {
        toast.success(t('disconnected'));
        setQr(null);
        setStatus('disconnected');
      }
      await consultar();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc('loadError'));
    } finally {
      setAgindo(false);
    }
  }

  async function remover() {
    if (!window.confirm(t('confirmRemove'))) return;
    setAgindo(true);
    try {
      await commerceMutate(
        `/api/whatsapp/connections/${connection.id}`,
        'DELETE'
      );
      toast.success(t('connectionRemoved'));
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc('loadError'));
    } finally {
      setAgindo(false);
    }
  }

  return (
    <li className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className={cn('h-2 w-2 shrink-0 rounded-full', meta.dot)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {connection.name}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {phone ? `+${phone}` : t(meta.key)}
            {connection.provider === 'meta_cloud'
              ? ` · ${t('methodMeta')}`
              : ''}
          </span>
        </span>
        <span
          className={cn(
            'shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium',
            meta.chip
          )}
        >
          {t(meta.key)}
        </span>
      </button>

      {expanded ? (
        <div className="border-t border-border px-4 py-4">
          {connection.provider !== 'qr' ? (
            <p className="text-[13px] text-muted-foreground">
              {t('methodMetaHint')}
            </p>
          ) : status === 'connected' ? (
            <div className="space-y-2 text-[13px]">
              <Linha rotulo={t('number')} valor={phone ? `+${phone}` : '—'} />
              <Linha
                rotulo={t('lastSync')}
                valor={
                  connection.last_seen_at
                    ? formatDateTimeBR(connection.last_seen_at)
                    : '—'
                }
              />
              <Linha
                rotulo={t('sellers')}
                valor={
                  connection.restricted
                    ? t('sellersRestricted', { count: connection.member_count })
                    : t('sellersAll')
                }
              />
            </div>
          ) : qr ? (
            <div className="flex flex-col items-center gap-3">
              <p className="text-sm font-medium text-foreground">
                {t('scanTitle')}
              </p>
              {/* O QR vem como data URL efêmera do serviço; next/image
                  não agrega nada aqui e exigiria configurar um domínio
                  remoto para algo que nunca é servido por URL. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qr}
                alt={t('scanTitle')}
                width={240}
                height={240}
                className="rounded-lg border border-border bg-white p-2"
              />
              <ol className="space-y-1 text-[12px] text-muted-foreground">
                <li>1. {t('scanStep1')}</li>
                <li>2. {t('scanStep2')}</li>
                <li>3. {t('scanStep3')}</li>
              </ol>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-4">
              <QrCode className="h-8 w-8 text-muted-foreground" />
              <p className="text-[13px] text-muted-foreground">
                {status === 'connecting' || buscando
                  ? t('generatingQr')
                  : t(meta.key)}
              </p>
            </div>
          )}

          {canManage && connection.provider === 'qr' ? (
            <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
              {status === 'connected' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-8 text-xs"
                  onClick={() => acao('disconnect')}
                  disabled={agindo}
                >
                  <Unplug className="mr-1.5 h-3.5 w-3.5" />
                  {t('disconnect')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => acao('connect')}
                  disabled={agindo}
                >
                  {agindo ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <QrCode className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {status === 'disconnected' ? t('connect') : t('reconnect')}
                </Button>
              )}

              {qr ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-8 text-xs"
                  onClick={() => acao('restart')}
                  disabled={agindo}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  {t('newQr')}
                </Button>
              ) : null}

              <Button
                size="sm"
                variant="secondary"
                className="ml-auto h-8 text-xs"
                onClick={remover}
                disabled={agindo}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                {t('remove')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Linha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{rotulo}</span>
      <span className="text-foreground">{valor}</span>
    </div>
  );
}

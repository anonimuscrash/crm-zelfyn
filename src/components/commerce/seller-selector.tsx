'use client';

// ============================================================
// Seletor "ver dashboard como" (§12).
//
// Renderiza NADA quando não faz sentido: vendedor não tem escolha, e
// master sem equipe teria um dropdown de um item só. `canFilterBySeller`
// concentra essa decisão.
//
// O valor escolhido vai para a query da API, mas o banco não confia
// nele — `resolve_seller_scope` força o próprio uid para quem não é
// master. Este componente é conveniência, não controle de acesso.
// ============================================================

import { useTranslations } from 'next-intl';

import { useCommerceFetch } from '@/hooks/use-commerce';
import { canFilterBySeller } from '@/lib/auth/permissions';
import type { SessionContext } from '@/lib/auth/permissions';
import type { SellerOption } from '@/lib/commerce/types';

export function SellerSelector({
  context,
  value,
  onChange,
}: {
  context: SessionContext | null;
  /** `null` = visão geral da conta. */
  value: string | null;
  onChange: (sellerId: string | null) => void;
}) {
  const t = useTranslations('Team');
  const podeFiltrar = canFilterBySeller(context);

  const { data } = useCommerceFetch<{ sellers: SellerOption[] }>(
    podeFiltrar ? '/api/commerce/team?options=1' : null
  );

  if (!podeFiltrar) return null;

  const vendedores = data?.sellers ?? [];

  return (
    <label className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">{t('viewLabel')}</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-9 rounded-lg border border-input bg-card px-2.5 text-[13px] text-foreground"
      >
        <option value="">{t('viewAll')}</option>
        {context?.user_id ? (
          <option value={context.user_id}>{t('viewMine')}</option>
        ) : null}
        {vendedores
          .filter((s) => s.user_id !== context?.user_id)
          .map((s) => (
            <option key={s.user_id} value={s.user_id}>
              {s.full_name}
            </option>
          ))}
      </select>
    </label>
  );
}

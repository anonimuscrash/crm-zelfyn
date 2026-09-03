// ============================================================
// Repositório do Platform Admin.
//
// ÚNICO módulo do sistema que lê através de tenants. Cada função
// aqui chama uma RPC gateada por `is_platform_admin()` — nenhuma
// delas usa `getCurrentAccount()`, porque a noção de "minha conta"
// não se aplica a quem administra a plataforma.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { RepositoryError } from '@/lib/commerce/products.repo';
import type { ResolvedPeriod, SeriesBucket } from '@/lib/commerce/periods';

function mapError(error: { code?: string; message: string }): never {
  if (error.code === '42501') {
    throw new RepositoryError('Acesso restrito à administração', 403);
  }
  if (error.code === '22023' || error.code === '23514') {
    throw new RepositoryError(error.message, 400);
  }
  if (error.code === 'P0002') {
    throw new RepositoryError('Conta não encontrada', 404);
  }
  throw new RepositoryError(error.message);
}

export interface PlatformMetrics {
  total_accounts: number;
  active_accounts: number;
  suspended_accounts: number;
  blocked_accounts: number;
  new_accounts: number;
  team_accounts: number;
  solo_accounts: number;
  total_users: number;
  total_sellers: number;
  new_users: number;
  active_users: number;
  total_orders: number;
  orders_in_period: number;
  volume_cents: number;
  volume_all_time_cents: number;
}

export interface GrowthPoint {
  bucket_start: string;
  new_accounts: number;
  new_users: number;
  order_count: number;
  volume_cents: number;
}

export type AccountStatus = 'active' | 'suspended' | 'blocked';

export interface PlatformCustomer {
  account_id: string;
  account_name: string;
  status: AccountStatus;
  status_reason: string | null;
  status_changed_at: string | null;
  owner_name: string;
  owner_email: string;
  plan: string;
  team_enabled: boolean;
  member_count: number;
  seller_count: number;
  order_count: number;
  volume_cents: number;
  created_at: string;
  last_activity_at: string | null;
  /** Repetido em toda linha pela RPC; usado para a paginação. */
  total_count: number;
}

export interface ActivityRow {
  id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_label: string;
  account_name: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export const EMPTY_PLATFORM_METRICS: PlatformMetrics = {
  total_accounts: 0,
  active_accounts: 0,
  suspended_accounts: 0,
  blocked_accounts: 0,
  new_accounts: 0,
  team_accounts: 0,
  solo_accounts: 0,
  total_users: 0,
  total_sellers: 0,
  new_users: 0,
  active_users: 0,
  total_orders: 0,
  orders_in_period: 0,
  volume_cents: 0,
  volume_all_time_cents: 0,
};

export async function fetchPlatformMetrics(
  db: SupabaseClient,
  period: Pick<ResolvedPeriod, 'from' | 'to'>
): Promise<PlatformMetrics> {
  const { data, error } = await db.rpc('platform_metrics', {
    p_from: period.from.toISOString(),
    p_to: period.to.toISOString(),
  });

  if (error) mapError(error);
  const row = Array.isArray(data) ? data[0] : data;
  return (row as PlatformMetrics) ?? EMPTY_PLATFORM_METRICS;
}

export async function fetchGrowthSeries(
  db: SupabaseClient,
  period: Pick<ResolvedPeriod, 'from' | 'to' | 'bucket'>,
  timezone: string,
  bucketOverride?: SeriesBucket
): Promise<GrowthPoint[]> {
  const { data, error } = await db.rpc('platform_growth_series', {
    p_from: period.from.toISOString(),
    p_to: period.to.toISOString(),
    p_bucket: bucketOverride ?? period.bucket,
    p_timezone: timezone,
  });

  if (error) mapError(error);
  return (data ?? []) as GrowthPoint[];
}

export async function fetchPlatformCustomers(
  db: SupabaseClient,
  {
    search,
    status,
    limit = 50,
    offset = 0,
  }: {
    search?: string | null;
    status?: AccountStatus | null;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ rows: PlatformCustomer[]; total: number }> {
  const { data, error } = await db.rpc('platform_customers', {
    p_search: search ?? null,
    p_status: status ?? null,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) mapError(error);
  const rows = (data ?? []) as PlatformCustomer[];
  // `total_count` vem repetido em cada linha. Zero linhas = zero
  // total, que também é a resposta certa para uma busca sem
  // resultado.
  return { rows, total: rows[0]?.total_count ?? 0 };
}

export async function setAccountStatus(
  db: SupabaseClient,
  accountId: string,
  status: AccountStatus,
  reason?: string | null
): Promise<void> {
  const { error } = await db.rpc('platform_set_account_status', {
    p_account_id: accountId,
    p_status: status,
    p_reason: reason ?? null,
  });

  if (error) mapError(error);
}

export async function fetchRecentActivity(
  db: SupabaseClient,
  limit = 50
): Promise<ActivityRow[]> {
  const { data, error } = await db.rpc('platform_recent_activity', {
    p_limit: limit,
  });

  if (error) mapError(error);
  return (data ?? []) as ActivityRow[];
}

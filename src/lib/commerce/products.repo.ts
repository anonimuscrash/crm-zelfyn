// ============================================================
// Products repository.
//
// Every function takes an explicit `accountId` and filters on it,
// even though RLS would already scope the read. Belt and braces:
// RLS is the security boundary, the explicit filter is the one that
// survives someone later swapping in a service-role client for a
// batch job. The two together are why a cross-tenant read here
// needs two independent mistakes, not one.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  Paginated,
  ProductInput,
  ProductListFilters,
  ProductRow,
} from './types';

const PRODUCT_COLUMNS =
  'id, account_id, name, sku, description, category, unit_cost_cents, unit_price_cents, is_active, image_url, stock_quantity, notes, created_at, updated_at';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export class RepositoryError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'RepositoryError';
    this.status = status;
  }
}

/**
 * PostgREST surfaces a unique-violation as code 23505. The only
 * unique index on products is (account_id, sku), so mapping it to a
 * readable message here spares every caller from parsing error
 * codes — and spares the operator from "duplicate key value violates
 * unique constraint idx_products_account_sku_unique".
 */
function mapWriteError(error: { code?: string; message: string }): never {
  if (error.code === '23505') {
    throw new RepositoryError('Já existe um produto com este SKU', 409);
  }
  throw new RepositoryError(error.message, 500);
}

function clampPage(filters: ProductListFilters) {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE))
  );
  return { page, pageSize, from: (page - 1) * pageSize };
}

/**
 * Escape a user search term for PostgREST's `or(...)` grammar.
 *
 * Commas separate branches and parentheses delimit them, so an
 * unescaped `,` or `)` in a product search would either silently
 * change the filter or 400 the request. Percent and underscore are
 * ILIKE wildcards and are neutralised so a search for "50%" doesn't
 * match everything.
 */
function escapeSearchTerm(term: string): string {
  return term
    .replace(/[%_]/g, (m) => `\\${m}`)
    .replace(/[(),]/g, ' ')
    .trim();
}

export async function listProducts(
  db: SupabaseClient,
  accountId: string,
  filters: ProductListFilters = {}
): Promise<Paginated<ProductRow>> {
  const { page, pageSize, from } = clampPage(filters);

  let query = db
    .from('products')
    .select(PRODUCT_COLUMNS, { count: 'exact' })
    .eq('account_id', accountId);

  if (filters.isActive !== undefined) {
    query = query.eq('is_active', filters.isActive);
  }
  if (filters.category) {
    query = query.eq('category', filters.category);
  }
  if (filters.search?.trim()) {
    const term = escapeSearchTerm(filters.search);
    if (term) {
      query = query.or(`name.ilike.%${term}%,sku.ilike.%${term}%`);
    }
  }

  const sort = filters.sort ?? 'name';
  const ascending = (filters.direction ?? 'asc') === 'asc';
  query = query.order(sort, { ascending, nullsFirst: false });

  const { data, error, count } = await query.range(from, from + pageSize - 1);
  if (error) throw new RepositoryError(error.message);

  return {
    rows: (data ?? []) as ProductRow[],
    total: count ?? 0,
    page,
    pageSize,
  };
}

/** Lightweight list for the sale form's product picker. */
export async function listActiveProductsForPicker(
  db: SupabaseClient,
  accountId: string,
  search?: string
): Promise<
  Pick<
    ProductRow,
    'id' | 'name' | 'sku' | 'unit_price_cents' | 'unit_cost_cents' | 'stock_quantity'
  >[]
> {
  let query = db
    .from('products')
    .select('id, name, sku, unit_price_cents, unit_cost_cents, stock_quantity')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('name', { ascending: true })
    .limit(50);

  if (search?.trim()) {
    const term = escapeSearchTerm(search);
    if (term) query = query.or(`name.ilike.%${term}%,sku.ilike.%${term}%`);
  }

  const { data, error } = await query;
  if (error) throw new RepositoryError(error.message);
  return data ?? [];
}

export async function getProduct(
  db: SupabaseClient,
  accountId: string,
  id: string
): Promise<ProductRow | null> {
  const { data, error } = await db
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();

  if (error) throw new RepositoryError(error.message);
  return (data as ProductRow) ?? null;
}

export async function createProduct(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  input: ProductInput
): Promise<ProductRow> {
  const { data, error } = await db
    .from('products')
    .insert({ ...input, account_id: accountId, created_by_user_id: userId })
    .select(PRODUCT_COLUMNS)
    .single();

  if (error) mapWriteError(error);
  return data as ProductRow;
}

/**
 * Update a product's current defaults.
 *
 * Deliberately has NO effect on past orders: order_items carry their
 * own price/cost snapshot (§9), so changing a price here reprices
 * future sales only. That property is enforced by the schema, not by
 * this function — which is exactly why it's safe to keep this a
 * plain UPDATE.
 */
export async function updateProduct(
  db: SupabaseClient,
  accountId: string,
  id: string,
  input: Partial<ProductInput>
): Promise<ProductRow> {
  const { data, error } = await db
    .from('products')
    .update(input)
    .eq('account_id', accountId)
    .eq('id', id)
    .select(PRODUCT_COLUMNS)
    .maybeSingle();

  if (error) mapWriteError(error);
  if (!data) throw new RepositoryError('Produto não encontrado', 404);
  return data as ProductRow;
}

/**
 * Products are archived, not deleted, by default. A hard delete
 * would sever order_items.product_id (SET NULL) and, while the
 * snapshots keep the money correct, the ranking would lose the
 * ability to link a historical line back to a live product page.
 */
export async function archiveProduct(
  db: SupabaseClient,
  accountId: string,
  id: string
): Promise<ProductRow> {
  return updateProduct(db, accountId, id, { is_active: false });
}

export async function deleteProduct(
  db: SupabaseClient,
  accountId: string,
  id: string
): Promise<void> {
  const { error } = await db
    .from('products')
    .delete()
    .eq('account_id', accountId)
    .eq('id', id);

  if (error) throw new RepositoryError(error.message);
}

/** Distinct categories in use, for the filter dropdown. */
export async function listProductCategories(
  db: SupabaseClient,
  accountId: string
): Promise<string[]> {
  const { data, error } = await db
    .from('products')
    .select('category')
    .eq('account_id', accountId)
    .not('category', 'is', null);

  if (error) throw new RepositoryError(error.message);

  const seen = new Set<string>();
  for (const row of (data ?? []) as { category: string | null }[]) {
    if (row.category) seen.add(row.category);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

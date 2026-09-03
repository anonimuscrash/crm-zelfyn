// ============================================================
// Operational expenses + their categories.
//
// These rows are the SECOND line of the P&L and never touch an
// order. Nothing in this file joins to `orders` — the separation
// from per-sale direct costs (§18) is structural, not a convention
// someone has to remember.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { RepositoryError } from './products.repo';
import type {
  ExpenseCategoryRow,
  ExpenseInput,
  ExpenseListFilters,
  ExpenseRow,
  Paginated,
} from './types';

const EXPENSE_COLUMNS =
  'id, account_id, description, amount_cents, category_id, category_name_snapshot, incurred_on, supplier, payment_method, notes, is_recurring, recurrence, created_at, updated_at';

const CATEGORY_COLUMNS = 'id, account_id, name, slug, color, is_system';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function escapeSearchTerm(term: string): string {
  return term
    .replace(/[%_]/g, (m) => `\\${m}`)
    .replace(/[(),]/g, ' ')
    .trim();
}

// ------------------------------------------------------------
// Categories
// ------------------------------------------------------------

/**
 * Read categories, seeding the default set on first call.
 *
 * The seed is idempotent (ON CONFLICT DO NOTHING) and runs lazily
 * rather than in the signup trigger, so accounts that predate this
 * migration get their categories the first time someone opens the
 * expenses screen — no backfill script, no empty dropdown.
 */
export async function listExpenseCategories(
  db: SupabaseClient,
  accountId: string
): Promise<ExpenseCategoryRow[]> {
  const { error: seedError } = await db.rpc(
    'ensure_default_expense_categories',
    { p_account_id: accountId }
  );
  // A failed seed must not blank the screen: an account that already
  // has categories doesn't need it, and the read below is the thing
  // the caller actually asked for.
  if (seedError) {
    console.warn('[expenses] category seed skipped:', seedError.message);
  }

  const { data, error } = await db
    .from('expense_categories')
    .select(CATEGORY_COLUMNS)
    .eq('account_id', accountId)
    .order('name', { ascending: true });

  if (error) throw new RepositoryError(error.message);
  return (data ?? []) as ExpenseCategoryRow[];
}

export async function createExpenseCategory(
  db: SupabaseClient,
  accountId: string,
  input: { name: string; color?: string }
): Promise<ExpenseCategoryRow> {
  const slug = input.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);

  if (!slug) {
    throw new RepositoryError('Nome de categoria inválido', 400);
  }

  const { data, error } = await db
    .from('expense_categories')
    .insert({
      account_id: accountId,
      name: input.name.trim(),
      slug,
      color: input.color ?? '#64748b',
      is_system: false,
    })
    .select(CATEGORY_COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new RepositoryError('Já existe uma categoria com este nome', 409);
    }
    throw new RepositoryError(error.message);
  }
  return data as ExpenseCategoryRow;
}

// ------------------------------------------------------------
// Expenses
// ------------------------------------------------------------

export async function listExpenses(
  db: SupabaseClient,
  accountId: string,
  filters: ExpenseListFilters = {}
): Promise<Paginated<ExpenseRow>> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE))
  );
  const from = (page - 1) * pageSize;

  let query = db
    .from('operational_expenses')
    .select(EXPENSE_COLUMNS, { count: 'exact' })
    .eq('account_id', accountId);

  if (filters.categoryId) query = query.eq('category_id', filters.categoryId);
  if (filters.from) query = query.gte('incurred_on', filters.from);
  if (filters.to) query = query.lte('incurred_on', filters.to);
  if (filters.search?.trim()) {
    const term = escapeSearchTerm(filters.search);
    if (term) {
      query = query.or(
        `description.ilike.%${term}%,supplier.ilike.%${term}%`
      );
    }
  }

  const { data, error, count } = await query
    .order('incurred_on', { ascending: false })
    .range(from, from + pageSize - 1);

  if (error) throw new RepositoryError(error.message);

  return {
    rows: (data ?? []) as ExpenseRow[],
    total: count ?? 0,
    page,
    pageSize,
  };
}

export async function createExpense(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  input: ExpenseInput
): Promise<ExpenseRow> {
  // Denormalise the category name so a later category deletion
  // leaves the historical entry readable instead of "Sem categoria".
  let snapshot: string | null = null;
  if (input.category_id) {
    const { data } = await db
      .from('expense_categories')
      .select('name')
      .eq('account_id', accountId)
      .eq('id', input.category_id)
      .maybeSingle();
    snapshot = (data as { name: string } | null)?.name ?? null;

    if (!snapshot) {
      throw new RepositoryError('Categoria não encontrada nesta conta', 400);
    }
  }

  const { data, error } = await db
    .from('operational_expenses')
    .insert({
      ...input,
      account_id: accountId,
      created_by_user_id: userId,
      category_name_snapshot: snapshot,
    })
    .select(EXPENSE_COLUMNS)
    .single();

  if (error) throw new RepositoryError(error.message);
  return data as ExpenseRow;
}

export async function updateExpense(
  db: SupabaseClient,
  accountId: string,
  id: string,
  input: Partial<ExpenseInput>
): Promise<ExpenseRow> {
  const { data, error } = await db
    .from('operational_expenses')
    .update(input)
    .eq('account_id', accountId)
    .eq('id', id)
    .select(EXPENSE_COLUMNS)
    .maybeSingle();

  if (error) throw new RepositoryError(error.message);
  if (!data) throw new RepositoryError('Despesa não encontrada', 404);
  return data as ExpenseRow;
}

export async function deleteExpense(
  db: SupabaseClient,
  accountId: string,
  id: string
): Promise<void> {
  const { error } = await db
    .from('operational_expenses')
    .delete()
    .eq('account_id', accountId)
    .eq('id', id);

  if (error) throw new RepositoryError(error.message);
}

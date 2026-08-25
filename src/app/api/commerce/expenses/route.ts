import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  commerceErrorResponse,
  intParam,
  periodFromSearchParams,
  readJsonBody,
} from '@/lib/commerce/http';
import { createExpense, listExpenses } from '@/lib/commerce/expenses.repo';
import { toISODateLocal } from '@/lib/commerce/periods';
import { parseExpenseInput } from '@/lib/commerce/validation';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const params = new URL(request.url).searchParams;
    const period = params.get('period') ? periodFromSearchParams(params) : null;

    const result = await listExpenses(ctx.supabase, ctx.accountId, {
      search: params.get('search') ?? undefined,
      categoryId: params.get('categoryId') ?? undefined,
      // incurred_on is a DATE, so the window is expressed as
      // inclusive dates rather than the half-open timestamp interval
      // used for orders.
      from: period ? toISODateLocal(period.from) : undefined,
      to: period
        ? toISODateLocal(new Date(period.to.getTime() - 86_400_000))
        : undefined,
      page: intParam(params, 'page', 1, { max: 10_000 }),
      pageSize: intParam(params, 'pageSize', 25),
    });

    return NextResponse.json(result);
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const input = parseExpenseInput(await readJsonBody(request));
    const expense = await createExpense(
      ctx.supabase,
      ctx.accountId,
      ctx.userId,
      input
    );
    return NextResponse.json(expense, { status: 201 });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

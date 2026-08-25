import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse, readJsonBody } from '@/lib/commerce/http';
import {
  createExpenseCategory,
  listExpenseCategories,
} from '@/lib/commerce/expenses.repo';
import { ValidationError } from '@/lib/commerce/validation';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    const categories = await listExpenseCategories(ctx.supabase, ctx.accountId);
    return NextResponse.json({ categories });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await readJsonBody(request)) as {
      name?: unknown;
      color?: unknown;
    };

    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new ValidationError('Nome da categoria é obrigatório', 'name');
    }
    if (body.name.trim().length > 60) {
      throw new ValidationError('Nome da categoria é muito longo', 'name');
    }

    const category = await createExpenseCategory(ctx.supabase, ctx.accountId, {
      name: body.name,
      color: typeof body.color === 'string' ? body.color : undefined,
    });
    return NextResponse.json(category, { status: 201 });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

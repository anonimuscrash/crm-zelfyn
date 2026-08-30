import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse, readJsonBody } from '@/lib/commerce/http';
import { deleteExpense, updateExpense } from '@/lib/commerce/expenses.repo';
import { parseExpenseInput } from '@/lib/commerce/validation';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const input = parseExpenseInput(await readJsonBody(request));
    const expense = await updateExpense(ctx.supabase, ctx.accountId, id, input);
    return NextResponse.json(expense);
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    await deleteExpense(ctx.supabase, ctx.accountId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

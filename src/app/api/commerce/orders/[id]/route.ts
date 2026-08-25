import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse, readJsonBody } from '@/lib/commerce/http';
import {
  deleteOrder,
  getOrder,
  updateOrder,
} from '@/lib/commerce/orders.repo';
import { parseOrderPatch } from '@/lib/commerce/validation';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await params;
    const order = await getOrder(ctx.supabase, ctx.accountId, id);
    if (!order) {
      return NextResponse.json(
        { error: 'Pedido não encontrado' },
        { status: 404 }
      );
    }
    return NextResponse.json(order);
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

/**
 * Header-only updates. `parseOrderPatch` rejects any attempt to
 * write a derived total, so this endpoint cannot be used to book a
 * fabricated margin — the numbers only ever move because the
 * database recomputed them.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const patch = parseOrderPatch(await readJsonBody(request));
    const order = await updateOrder(ctx.supabase, ctx.accountId, id, patch);
    return NextResponse.json(order);
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
    await deleteOrder(ctx.supabase, ctx.accountId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

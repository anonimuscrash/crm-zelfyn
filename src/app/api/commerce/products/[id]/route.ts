import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse, readJsonBody } from '@/lib/commerce/http';
import {
  archiveProduct,
  deleteProduct,
  getProduct,
  updateProduct,
} from '@/lib/commerce/products.repo';
import { parseProductInput } from '@/lib/commerce/validation';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await params;
    const product = await getProduct(ctx.supabase, ctx.accountId, id);
    if (!product) {
      return NextResponse.json(
        { error: 'Produto não encontrado' },
        { status: 404 }
      );
    }
    return NextResponse.json(product);
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    // Full-shape validation on a PATCH: the product form always
    // submits every field, and accepting partial money updates would
    // mean re-deriving "is this price still valid" per field.
    const input = parseProductInput(await readJsonBody(request));
    const product = await updateProduct(ctx.supabase, ctx.accountId, id, input);
    return NextResponse.json(product);
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

/**
 * Archive by default; `?hard=1` (admin only) actually removes the
 * row. Past order lines keep their snapshots either way, so a hard
 * delete costs history no money — only the link back to a live
 * product page.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const hard = new URL(request.url).searchParams.get('hard') === '1';
    const ctx = await requireRole(hard ? 'admin' : 'agent');
    const { id } = await params;

    if (hard) {
      await deleteProduct(ctx.supabase, ctx.accountId, id);
      return NextResponse.json({ ok: true, deleted: true });
    }

    const product = await archiveProduct(ctx.supabase, ctx.accountId, id);
    return NextResponse.json({ ok: true, archived: true, product });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

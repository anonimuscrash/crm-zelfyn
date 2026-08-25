import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  commerceErrorResponse,
  intParam,
  readJsonBody,
} from '@/lib/commerce/http';
import {
  createProduct,
  listProductCategories,
  listProducts,
} from '@/lib/commerce/products.repo';
import { parseProductInput } from '@/lib/commerce/validation';
import type { ProductListFilters } from '@/lib/commerce/types';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const params = new URL(request.url).searchParams;

    // `?categories=1` is a cheap side-channel for the filter
    // dropdown — one endpoint, no extra route file for a string[].
    if (params.get('categories') === '1') {
      const categories = await listProductCategories(
        ctx.supabase,
        ctx.accountId
      );
      return NextResponse.json({ categories });
    }

    const activeParam = params.get('active');
    const filters: ProductListFilters = {
      search: params.get('search') ?? undefined,
      category: params.get('category') ?? undefined,
      isActive:
        activeParam === null || activeParam === 'all'
          ? undefined
          : activeParam === 'true' || activeParam === '1',
      page: intParam(params, 'page', 1, { max: 10_000 }),
      pageSize: intParam(params, 'pageSize', 25),
      sort:
        (params.get('sort') as ProductListFilters['sort']) ?? undefined,
      direction:
        params.get('direction') === 'desc' ? 'desc' : 'asc',
    };

    const result = await listProducts(ctx.supabase, ctx.accountId, filters);
    return NextResponse.json(result);
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const input = parseProductInput(await readJsonBody(request));
    const product = await createProduct(
      ctx.supabase,
      ctx.accountId,
      ctx.userId,
      input
    );
    return NextResponse.json(product, { status: 201 });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

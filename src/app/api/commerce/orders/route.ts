import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import {
  commerceErrorResponse,
  intParam,
  periodFromSearchParams,
  readJsonBody,
} from '@/lib/commerce/http';
import {
  countOrdersByStatus,
  createOrder,
  listOrders,
  listOrdersForBoard,
} from '@/lib/commerce/orders.repo';
import { isOrderStatus } from '@/lib/commerce/order-status';
import { parseCreateOrderInput } from '@/lib/commerce/validation';
import type { OrderListFilters, OrderStatus } from '@/lib/commerce/types';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const params = new URL(request.url).searchParams;

    // Board mode returns every column in one payload — the Kanban
    // needs all statuses at once, and ten paginated calls would make
    // drag-and-drop feel broken while columns trickle in.
    if (params.get('view') === 'board') {
      const period = params.get('period')
        ? periodFromSearchParams(params)
        : null;
      const [orders, counts] = await Promise.all([
        listOrdersForBoard(ctx.supabase, ctx.accountId, {
          limitPerColumn: intParam(params, 'limitPerColumn', 50, { max: 200 }),
          from: period?.from.toISOString(),
          to: period?.to.toISOString(),
        }),
        countOrdersByStatus(ctx.supabase, ctx.accountId, {
          from: period?.from.toISOString(),
          to: period?.to.toISOString(),
        }),
      ]);
      return NextResponse.json({ orders, counts });
    }

    const statusParam = params.getAll('status').filter(isOrderStatus);
    const period = params.get('period') ? periodFromSearchParams(params) : null;

    const filters: OrderListFilters = {
      search: params.get('search') ?? undefined,
      status: statusParam.length ? (statusParam as OrderStatus[]) : undefined,
      contactId: params.get('contactId') ?? undefined,
      productId: params.get('productId') ?? undefined,
      sellerUserId: params.get('sellerUserId') ?? undefined,
      from: period?.from.toISOString(),
      to: period?.to.toISOString(),
      minCents: params.get('minCents')
        ? Number(params.get('minCents'))
        : undefined,
      maxCents: params.get('maxCents')
        ? Number(params.get('maxCents'))
        : undefined,
      page: intParam(params, 'page', 1, { max: 10_000 }),
      pageSize: intParam(params, 'pageSize', 25),
      sort: (params.get('sort') as OrderListFilters['sort']) ?? undefined,
      direction: params.get('direction') === 'asc' ? 'asc' : 'desc',
    };

    const result = await listOrders(ctx.supabase, ctx.accountId, filters);
    return NextResponse.json(result);
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const input = parseCreateOrderInput(await readJsonBody(request));
    const order = await createOrder(ctx.supabase, ctx.accountId, input);
    return NextResponse.json(order, { status: 201 });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

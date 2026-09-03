import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { fetchCustomerStats } from '@/lib/commerce/analytics.repo';
import { commerceErrorResponse, intParam } from '@/lib/commerce/http';
import {
  listOrdersForContact,
  listProductsBoughtByContact,
} from '@/lib/commerce/orders.repo';

/**
 * Customer commercial panel.
 *
 * Contacts stay the customer entity — this endpoint layers the
 * commercial figures on top of a contact_id rather than introducing
 * a parallel customer record (§16).
 *
 * With `?contactId=`, returns that customer's full picture. Without,
 * returns the ranked list for the "clientes que mais compraram"
 * report.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const params = new URL(request.url).searchParams;
    const contactId = params.get('contactId');

    if (!contactId) {
      const customers = await fetchCustomerStats(ctx.supabase, ctx.accountId, {
        limit: intParam(params, 'limit', 50),
      });
      return NextResponse.json({ customers });
    }

    const [stats, orders, products] = await Promise.all([
      fetchCustomerStats(ctx.supabase, ctx.accountId, { contactId, limit: 1 }),
      listOrdersForContact(ctx.supabase, ctx.accountId, contactId, 20),
      listProductsBoughtByContact(ctx.supabase, ctx.accountId, contactId),
    ]);

    return NextResponse.json({
      // No orders yet is a valid state, not an error — the panel
      // renders an empty-state instead of a 404.
      stats: stats[0] ?? null,
      orders,
      products,
    });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

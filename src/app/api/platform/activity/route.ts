import { NextResponse } from 'next/server';

import { commerceErrorResponse, intParam } from '@/lib/commerce/http';
import { requirePlatformAdmin } from '@/lib/platform/guard';
import { fetchRecentActivity } from '@/lib/platform/repo';

export async function GET(request: Request) {
  try {
    const ctx = await requirePlatformAdmin();
    const params = new URL(request.url).searchParams;
    const activity = await fetchRecentActivity(
      ctx.supabase,
      intParam(params, 'limit', 50, { max: 200 })
    );
    return NextResponse.json({ activity });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

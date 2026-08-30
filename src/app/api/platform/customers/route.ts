import { NextResponse } from 'next/server';

import {
  commerceErrorResponse,
  intParam,
  readJsonBody,
} from '@/lib/commerce/http';
import { ValidationError } from '@/lib/commerce/validation';
import { requirePlatformAdmin } from '@/lib/platform/guard';
import {
  fetchPlatformCustomers,
  setAccountStatus,
  type AccountStatus,
} from '@/lib/platform/repo';

const STATUSES: AccountStatus[] = ['active', 'suspended', 'blocked'];

export async function GET(request: Request) {
  try {
    const ctx = await requirePlatformAdmin();
    const params = new URL(request.url).searchParams;

    const statusParam = params.get('status');
    const status =
      statusParam && STATUSES.includes(statusParam as AccountStatus)
        ? (statusParam as AccountStatus)
        : null;

    const page = intParam(params, 'page', 1, { max: 10_000 });
    const pageSize = intParam(params, 'pageSize', 25);

    const { rows, total } = await fetchPlatformCustomers(ctx.supabase, {
      search: params.get('search'),
      status,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    return NextResponse.json({ rows, total, page, pageSize });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

/**
 * Bloquear, suspender ou reativar uma conta.
 *
 * Bloqueio NÃO apaga nada — troca uma coluna e registra quem, quando
 * e por quê. As travas contra bloquear a própria conta ou a de outro
 * admin ficam na RPC, não aqui: uma rota pode ser reescrita, a
 * função do banco continua recusando.
 */
export async function PATCH(request: Request) {
  try {
    const ctx = await requirePlatformAdmin();
    const body = (await readJsonBody(request)) as {
      account_id?: unknown;
      status?: unknown;
      reason?: unknown;
    };

    if (
      typeof body.account_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        body.account_id
      )
    ) {
      throw new ValidationError('account_id inválido', 'account_id');
    }

    if (!STATUSES.includes(body.status as AccountStatus)) {
      throw new ValidationError(
        "status deve ser 'active', 'suspended' ou 'blocked'",
        'status'
      );
    }

    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim().slice(0, 500)
        : null;

    await setAccountStatus(
      ctx.supabase,
      body.account_id,
      body.status as AccountStatus,
      reason
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

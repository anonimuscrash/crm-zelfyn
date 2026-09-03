// ============================================================
// Shared HTTP plumbing for the commerce endpoints.
//
// Extends the existing `toErrorResponse` from lib/auth/account with
// the two error classes this module introduces, so a route body
// stays a try/catch with one `return commerceErrorResponse(err)`.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { RepositoryError } from './products.repo';
import { ValidationError } from './validation';
import {
  isPeriodPreset,
  resolvePeriod,
  type PeriodSelection,
  type ResolvedPeriod,
} from './periods';

export function commerceErrorResponse(err: unknown): NextResponse {
  if (err instanceof ValidationError) {
    return NextResponse.json(
      { error: err.message, field: err.field },
      { status: err.status }
    );
  }
  if (err instanceof RepositoryError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  // Falls through to the project's existing handler, which maps
  // Unauthorized/Forbidden and collapses anything else to a 500
  // without leaking internals.
  return toErrorResponse(err);
}

/** Read and JSON-parse a request body, rejecting malformed input as 400. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const body = await request.json().catch(() => undefined);
  if (body === undefined) {
    throw new ValidationError('Corpo da requisição inválido ou ausente');
  }
  return body;
}

/**
 * Build a period from `?period=&from=&to=` query params.
 *
 * `resolvePeriod` already degrades an invalid custom range to
 * `last30`, so a hand-edited URL yields a usable dashboard rather
 * than an error page.
 */
export function periodFromSearchParams(params: URLSearchParams): ResolvedPeriod {
  const preset = params.get('period');
  const selection: PeriodSelection = {
    preset: isPeriodPreset(preset) ? preset : 'last30',
    fromDate: params.get('from') ?? undefined,
    toDate: params.get('to') ?? undefined,
  };
  return resolvePeriod(selection);
}

/** Bounded integer query param. */
export function intParam(
  params: URLSearchParams,
  key: string,
  fallback: number,
  { min = 1, max = 100 }: { min?: number; max?: number } = {}
): number {
  const raw = params.get(key);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * A timezone name from the client, validated loosely.
 *
 * The SQL side falls back to UTC for an unknown zone, so this only
 * needs to reject shapes that have no business reaching the query
 * at all.
 */
export function timezoneParam(params: URLSearchParams): string {
  const tz = params.get('tz');
  if (!tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return 'UTC';
  return tz;
}

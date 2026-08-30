'use client';

// ============================================================
// Client-side data access for the commerce screens.
//
// One fetch hook shape across every page: `{ data, error, loading,
// reload }`. No SWR/React Query in the project's dependency list, and
// adding one for six screens would be a bigger commitment than the
// ~80 lines below.
//
// The abort handling matters more than it looks: changing the period
// filter fires a new request while the old one is in flight, and
// without the guard the slower response can land last and repaint the
// dashboard with the wrong window's numbers.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  detectTimeZone,
  resolvePeriod,
  toISODateLocal,
  type PeriodSelection,
} from '@/lib/commerce/periods';

export interface FetchState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: string;
  } | null;
  return body?.error ?? `Erro ${res.status}`;
}

export function useCommerceFetch<T>(
  url: string | null,
  deps: unknown[] = []
): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!url) {
      setData(null);
      setLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res));
        return (await res.json()) as T;
      })
      .then((json) => {
        if (controller.signal.aborted) return;
        setData(json);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Erro inesperado');
        setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, nonce, ...deps]);

  return { data, error, loading, reload };
}

/**
 * Serialise a period selection into the query params every commerce
 * endpoint understands. Custom ranges are re-resolved first so a
 * half-filled custom form still produces a valid window rather than
 * `from=&to=`.
 */
export function periodQuery(selection: PeriodSelection): string {
  const params = new URLSearchParams();
  params.set('period', selection.preset);

  if (selection.preset === 'custom') {
    const resolved = resolvePeriod(selection);
    params.set('from', toISODateLocal(resolved.from));
    params.set(
      'to',
      toISODateLocal(new Date(resolved.to.getTime() - 86_400_000))
    );
  }

  params.set('tz', detectTimeZone());
  return params.toString();
}

/** POST/PATCH/DELETE helper with the same error contract as the hook. */
export async function commerceMutate<T>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

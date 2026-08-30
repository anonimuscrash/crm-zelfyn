'use client';

// ============================================================
// Contexto de sessão: papel, status da conta e feature flags.
//
// Uma chamada à RPC `session_context()` em vez de três consultas
// (profiles, accounts, account_settings). Isso importa no caminho
// crítico do login: cada round trip a mais é meio segundo de tela
// em branco antes de o usuário saber para onde está indo.
// ============================================================

import { useCallback, useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import type { SessionContext } from '@/lib/auth/permissions';

interface UseSessionContext {
  context: SessionContext | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useSessionContext(): UseSessionContext {
  const [context, setContext] = useState<SessionContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    supabase
      .rpc('session_context')
      .then(({ data, error: rpcError }) => {
        if (cancelled) return;

        if (rpcError) {
          // Sessão expirada não é erro a exibir — é redirecionar
          // para o login, o que o layout já faz. Guardamos a
          // mensagem mesmo assim para o caso de ser outra coisa.
          setError(rpcError.message);
          setContext(null);
          setLoading(false);
          return;
        }

        const row = Array.isArray(data) ? data[0] : data;
        setContext((row as SessionContext) ?? null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { context, loading, error, reload };
}

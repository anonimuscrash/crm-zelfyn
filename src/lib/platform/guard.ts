// ============================================================
// Guarda de servidor para as rotas /api/platform/*.
//
// NÃO usa `getCurrentAccount()`: administrar a plataforma não é
// operar dentro de um tenant, e exigir account_id aqui criaria a
// ideia errada de que o admin "pertence" a algum cliente.
//
// A verificação é feita no BANCO (`is_platform_admin()`), não numa
// lista de e-mails ou variável de ambiente. Promover alguém é
// inserir uma linha em `platform_admins` — operação de console,
// sem endpoint que a crie.
// ============================================================

import { createClient } from '@/lib/supabase/server';
import { RepositoryError } from '@/lib/commerce/products.repo';

export interface PlatformContext {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
}

export async function requirePlatformAdmin(): Promise<PlatformContext> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new RepositoryError('Não autenticado', 401);
  }

  const { data, error } = await supabase.rpc('is_platform_admin', {
    p_user_id: user.id,
  });

  if (error) {
    throw new RepositoryError(error.message, 500);
  }

  if (data !== true) {
    // 404, não 403: para quem não é admin, a área administrativa não
    // deve nem confirmar que existe.
    throw new RepositoryError('Não encontrado', 404);
  }

  return { supabase, userId: user.id };
}

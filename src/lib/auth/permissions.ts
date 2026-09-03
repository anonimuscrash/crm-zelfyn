// ============================================================
// Papéis, contexto de sessão e permissões.
//
// A regra que sustenta tudo: NENHUMA decisão de acesso aqui é a
// única linha de defesa. Cada `can*()` abaixo tem uma policy RLS
// correspondente em 045_saas_foundation.sql. Estas funções existem
// para a interface não oferecer um botão que a API vai recusar —
// não para substituir a checagem do banco.
//
// Se alguém remover uma dessas checagens do frontend, o pior que
// acontece é um erro 403 feio. Se alguém remover a policy, vaza
// dado. É por isso que a policy é a verdade.
// ============================================================

/** Papel dentro do tenant, na linguagem do produto. */
export type AppRole = 'master' | 'seller' | 'viewer';

/** Papel na plataforma SaaS. Ortogonal ao papel no tenant. */
export type PlatformRole = 'platform_admin' | 'user';

export type AccountStatus = 'active' | 'suspended' | 'blocked';

/** Retorno da RPC `session_context()`. */
export interface SessionContext {
  user_id: string;
  account_id: string | null;
  account_name: string | null;
  account_status: AccountStatus;
  account_role: AppRole;
  platform_role: PlatformRole;
  team_enabled: boolean;
  inventory_enabled: boolean;
  printing_enabled: boolean;
  commissions_enabled: boolean;
  payments_enabled: boolean;
  customer_visibility: 'shared' | 'per_seller';
  onboarding_completed: boolean;
}

export type FeatureFlag =
  | 'team_enabled'
  | 'inventory_enabled'
  | 'printing_enabled'
  | 'commissions_enabled'
  | 'payments_enabled';

// ------------------------------------------------------------
// Predicados de papel
// ------------------------------------------------------------

export function isMaster(ctx: SessionContext | null): boolean {
  return ctx?.account_role === 'master';
}

export function isSeller(ctx: SessionContext | null): boolean {
  return ctx?.account_role === 'seller';
}

export function isPlatformAdmin(ctx: SessionContext | null): boolean {
  return ctx?.platform_role === 'platform_admin';
}

/**
 * A conta pode operar?
 *
 * `suspended` e `blocked` são distintos para o operador da
 * plataforma (um é temporário, outro não), mas idênticos para quem
 * tenta usar o sistema: nenhum dos dois entra.
 */
export function accountIsActive(ctx: SessionContext | null): boolean {
  return ctx?.account_status === 'active';
}

export function hasFeature(
  ctx: SessionContext | null,
  flag: FeatureFlag
): boolean {
  return Boolean(ctx?.[flag]);
}

// ------------------------------------------------------------
// Permissões
//
// Cada uma é `papel && conta ativa`. A conta ativa entra em toda
// permissão de ESCRITA porque um tenant bloqueado precisa parar de
// gravar, não só de navegar.
// ------------------------------------------------------------

export function canCreateSale(ctx: SessionContext | null): boolean {
  return (
    accountIsActive(ctx) && (isMaster(ctx) || isSeller(ctx))
  );
}

/** Cadastrar, editar, precificar e (des)ativar produto. Só master. */
export function canManageProducts(ctx: SessionContext | null): boolean {
  return accountIsActive(ctx) && isMaster(ctx);
}

/** Despesas operacionais são visão de dono. Vendedor não vê nem lança. */
export function canManageExpenses(ctx: SessionContext | null): boolean {
  return isMaster(ctx);
}

export function canViewExpenses(ctx: SessionContext | null): boolean {
  return isMaster(ctx);
}

/** Ver faturamento e lucro de TODO o workspace, não só o próprio. */
export function canViewAllSales(ctx: SessionContext | null): boolean {
  return isMaster(ctx);
}

export function canManageTeam(ctx: SessionContext | null): boolean {
  return accountIsActive(ctx) && isMaster(ctx);
}

export function canConfigureWorkspace(ctx: SessionContext | null): boolean {
  return accountIsActive(ctx) && isMaster(ctx);
}

/** Credenciais de integração nunca chegam ao vendedor. */
export function canManageIntegrations(ctx: SessionContext | null): boolean {
  return accountIsActive(ctx) && isMaster(ctx);
}

export function canAccessAdminArea(ctx: SessionContext | null): boolean {
  return isPlatformAdmin(ctx);
}

/**
 * O seletor "ver dashboard como" só faz sentido para um master que
 * de fato tem equipe. Para quem opera sozinho é um dropdown de um
 * item — ruído (§56).
 */
export function canFilterBySeller(ctx: SessionContext | null): boolean {
  return isMaster(ctx) && hasFeature(ctx, 'team_enabled');
}

// ------------------------------------------------------------
// Roteamento pós-login
// ------------------------------------------------------------

/**
 * Para onde mandar o usuário depois de autenticar.
 *
 * A ordem importa: o bloqueio vem ANTES do papel. Um platform_admin
 * cujo tenant esteja bloqueado ainda entra no /admin — ele
 * administra a plataforma, não depende do próprio tenant. Já um
 * master ou seller de conta bloqueada para na tela de conta
 * indisponível.
 */
export function landingPathFor(ctx: SessionContext | null): string {
  if (!ctx) return '/login';
  if (isPlatformAdmin(ctx)) return '/admin';
  if (!accountIsActive(ctx)) return '/account-blocked';
  return '/dashboard';
}

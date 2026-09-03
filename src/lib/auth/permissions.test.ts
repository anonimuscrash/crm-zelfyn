import { describe, expect, it } from 'vitest';

import {
  accountIsActive,
  canAccessAdminArea,
  canCreateSale,
  canFilterBySeller,
  canManageExpenses,
  canManageIntegrations,
  canManageProducts,
  canManageTeam,
  canViewAllSales,
  hasFeature,
  isMaster,
  isPlatformAdmin,
  isSeller,
  landingPathFor,
  type SessionContext,
} from './permissions';

const base: SessionContext = {
  user_id: 'u1',
  account_id: 'a1',
  account_name: 'Loja',
  account_status: 'active',
  account_role: 'master',
  platform_role: 'user',
  team_enabled: false,
  inventory_enabled: false,
  printing_enabled: false,
  commissions_enabled: false,
  payments_enabled: false,
  customer_visibility: 'shared',
  onboarding_completed: true,
};

const ctx = (over: Partial<SessionContext> = {}): SessionContext => ({
  ...base,
  ...over,
});

const master = ctx();
const seller = ctx({ account_role: 'seller' });
const viewer = ctx({ account_role: 'viewer' });
const admin = ctx({ platform_role: 'platform_admin' });
const blocked = ctx({ account_status: 'blocked' });
const suspended = ctx({ account_status: 'suspended' });

describe('predicados de papel', () => {
  it('separa master, seller e viewer', () => {
    expect(isMaster(master)).toBe(true);
    expect(isMaster(seller)).toBe(false);
    expect(isSeller(seller)).toBe(true);
    expect(isSeller(master)).toBe(false);
    expect(isMaster(viewer)).toBe(false);
    expect(isSeller(viewer)).toBe(false);
  });

  it('platform_admin é ortogonal ao papel no tenant', () => {
    // Um administrador da plataforma continua sendo master do
    // próprio workspace — as duas coisas coexistem.
    expect(isPlatformAdmin(admin)).toBe(true);
    expect(isMaster(admin)).toBe(true);
    expect(isPlatformAdmin(master)).toBe(false);
  });

  it('trata contexto ausente como sem permissão alguma', () => {
    expect(isMaster(null)).toBe(false);
    expect(isSeller(null)).toBe(false);
    expect(isPlatformAdmin(null)).toBe(false);
    expect(accountIsActive(null)).toBe(false);
  });
});

describe('status da conta', () => {
  it('só active opera', () => {
    expect(accountIsActive(master)).toBe(true);
    expect(accountIsActive(blocked)).toBe(false);
    expect(accountIsActive(suspended)).toBe(false);
  });
});

describe('permissões do vendedor — o que ele NÃO pode', () => {
  // O núcleo do §24. Cada uma destas tem policy RLS equivalente;
  // aqui garantimos que a interface não oferece o botão.
  it('não gerencia produtos', () => {
    expect(canManageProducts(seller)).toBe(false);
    expect(canManageProducts(master)).toBe(true);
  });

  it('não vê nem lança despesas operacionais', () => {
    expect(canManageExpenses(seller)).toBe(false);
    expect(canManageExpenses(master)).toBe(true);
  });

  it('não vê faturamento do workspace inteiro', () => {
    expect(canViewAllSales(seller)).toBe(false);
    expect(canViewAllSales(master)).toBe(true);
  });

  it('não gerencia equipe', () => {
    expect(canManageTeam(seller)).toBe(false);
    expect(canManageTeam(master)).toBe(true);
  });

  it('não configura integrações nem vê credenciais', () => {
    expect(canManageIntegrations(seller)).toBe(false);
    expect(canManageIntegrations(master)).toBe(true);
  });

  it('não acessa a área administrativa da plataforma', () => {
    expect(canAccessAdminArea(seller)).toBe(false);
    expect(canAccessAdminArea(master)).toBe(false);
    expect(canAccessAdminArea(admin)).toBe(true);
  });
});

describe('permissões do vendedor — o que ele pode', () => {
  it('registra venda', () => {
    expect(canCreateSale(seller)).toBe(true);
    expect(canCreateSale(master)).toBe(true);
  });

  it('viewer não registra venda', () => {
    expect(canCreateSale(viewer)).toBe(false);
  });
});

describe('conta bloqueada', () => {
  // Bloqueio suspende ESCRITA. Continuar deixando gravar numa conta
  // bloqueada tornaria o bloqueio decorativo.
  it('impede toda operação de escrita, inclusive do master', () => {
    const masterBloqueado = ctx({ account_status: 'blocked' });
    expect(canCreateSale(masterBloqueado)).toBe(false);
    expect(canManageProducts(masterBloqueado)).toBe(false);
    expect(canManageTeam(masterBloqueado)).toBe(false);
    expect(canConfigureBlocked()).toBe(false);
  });

  function canConfigureBlocked() {
    return canManageIntegrations(ctx({ account_status: 'suspended' }));
  }

  it('suspended e blocked são igualmente impeditivos para o usuário', () => {
    expect(canCreateSale(blocked)).toBe(canCreateSale(suspended));
    expect(canManageProducts(blocked)).toBe(canManageProducts(suspended));
  });

  it('leitura de despesas pelo master continua permitida', () => {
    // Ver o histórico não move dinheiro; um tenant bloqueado ainda
    // precisa conseguir consultar o que já registrou.
    expect(canManageExpenses(ctx({ account_status: 'blocked' }))).toBe(true);
  });
});

describe('feature flags', () => {
  it('lê a flag do contexto', () => {
    expect(hasFeature(master, 'team_enabled')).toBe(false);
    expect(hasFeature(ctx({ team_enabled: true }), 'team_enabled')).toBe(true);
    expect(hasFeature(null, 'team_enabled')).toBe(false);
  });

  it('o filtro por vendedor só aparece para master COM equipe', () => {
    // Modo individual não deve exibir dropdown de um item (§56).
    expect(canFilterBySeller(master)).toBe(false);
    expect(canFilterBySeller(ctx({ team_enabled: true }))).toBe(true);
    expect(
      canFilterBySeller(ctx({ account_role: 'seller', team_enabled: true }))
    ).toBe(false);
  });
});

describe('landingPathFor', () => {
  it('manda platform_admin para /admin', () => {
    expect(landingPathFor(admin)).toBe('/admin');
  });

  it('manda master e seller para /dashboard', () => {
    expect(landingPathFor(master)).toBe('/dashboard');
    expect(landingPathFor(seller)).toBe('/dashboard');
  });

  it('manda conta bloqueada para /account-blocked', () => {
    expect(landingPathFor(blocked)).toBe('/account-blocked');
    expect(landingPathFor(suspended)).toBe('/account-blocked');
  });

  it('platform_admin entra no /admin mesmo com o próprio tenant bloqueado', () => {
    // Ele administra a plataforma; não depende da saúde do tenant
    // dele. Sem isso, um admin que bloqueasse a própria conta por
    // engano perderia o acesso para desfazer.
    const adminBloqueado = ctx({
      platform_role: 'platform_admin',
      account_status: 'blocked',
    });
    expect(landingPathFor(adminBloqueado)).toBe('/admin');
  });

  it('sem contexto vai para /login', () => {
    expect(landingPathFor(null)).toBe('/login');
  });
});

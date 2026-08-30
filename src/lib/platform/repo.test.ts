import { describe, expect, it } from 'vitest';

import { EMPTY_PLATFORM_METRICS } from './repo';
import {
  canAccessAdminArea,
  landingPathFor,
  type SessionContext,
} from '@/lib/auth/permissions';

const ctx = (over: Partial<SessionContext> = {}): SessionContext => ({
  user_id: 'u',
  account_id: 'a',
  account_name: 'Conta',
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
  ...over,
});

describe('acesso à área administrativa', () => {
  it('só platform_admin entra', () => {
    expect(canAccessAdminArea(ctx({ platform_role: 'platform_admin' }))).toBe(
      true
    );
    expect(canAccessAdminArea(ctx())).toBe(false);
    expect(canAccessAdminArea(ctx({ account_role: 'seller' }))).toBe(false);
    expect(canAccessAdminArea(null)).toBe(false);
  });

  it('ser master do próprio tenant não dá acesso à plataforma', () => {
    // A distinção do §50: master administra um cliente, platform
    // admin administra o SaaS. Confundir os dois seria dar a cada
    // cliente a lista de todos os outros.
    const master = ctx({ account_role: 'master', platform_role: 'user' });
    expect(canAccessAdminArea(master)).toBe(false);
  });

  it('admin com o próprio tenant bloqueado ainda acessa /admin', () => {
    // Sem isso, um admin que bloqueasse a própria conta por engano
    // perderia o acesso necessário para desfazer.
    const admin = ctx({
      platform_role: 'platform_admin',
      account_status: 'blocked',
    });
    expect(landingPathFor(admin)).toBe('/admin');
    expect(canAccessAdminArea(admin)).toBe(true);
  });
});

describe('EMPTY_PLATFORM_METRICS', () => {
  it('é todo zero, para a tela nunca renderizar NaN', () => {
    const valores = Object.values(EMPTY_PLATFORM_METRICS);
    expect(valores).toHaveLength(15);
    expect(valores.every((v) => v === 0)).toBe(true);
  });
});

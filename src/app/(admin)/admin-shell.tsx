'use client';

// ============================================================
// Shell do Platform Admin.
//
// Mesma identidade visual do produto, mas claramente OUTRO contexto
// (§52): navegação horizontal em vez de sidebar, faixa "Admin" ao
// lado da marca, e nenhum atalho para operação de pedidos. Quem
// abre esta área precisa perceber em um segundo que não está mais
// dentro de um cliente.
//
// O guard aqui é conveniência de navegação. A barreira real são as
// RPCs `platform_*`, todas gateadas por `is_platform_admin()`: um
// não-admin que chamasse a API direto receberia erro,
// independentemente do que esta tela faça.
// ============================================================

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';

import { cn } from '@/lib/utils';
import { OperzaLoading, OperzaLogo } from '@/components/brand/operza-logo';
import { useSessionContext } from '@/hooks/use-session-context';
import { isPlatformAdmin } from '@/lib/auth/permissions';

const NAV = [
  { href: '/admin', labelKey: 'navOverview' },
  { href: '/admin/customers', labelKey: 'navCustomers' },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations('Admin');
  const router = useRouter();
  const pathname = usePathname();
  const { context, loading } = useSessionContext();

  // Sem sessão vai para o login; com sessão mas sem ser admin, vai
  // para o dashboard. Não mostramos "acesso negado": para quem não
  // é admin, esta área não precisa nem confirmar que existe.
  useEffect(() => {
    if (loading) return;
    if (!context) {
      router.replace('/login');
      return;
    }
    if (!isPlatformAdmin(context)) {
      router.replace('/dashboard');
    }
  }, [loading, context, router]);

  if (loading || !context) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <OperzaLoading />
      </div>
    );
  }

  if (!isPlatformAdmin(context)) return null;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-card">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-4 px-4">
          <Link href="/admin" className="flex shrink-0 items-center gap-2.5">
            <OperzaLogo height={22} priority />
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Admin
            </span>
          </Link>

          <nav className="flex flex-1 items-center gap-0.5">
            {NAV.map((item) => {
              const ativo =
                item.href === '/admin'
                  ? pathname === '/admin'
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                    ativo
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  {t(item.labelKey)}
                </Link>
              );
            })}
          </nav>

          <Link
            href="/dashboard"
            className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('backToApp')}</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6">{children}</main>
    </div>
  );
}

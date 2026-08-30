'use client';

// ============================================================
// Conta indisponível.
//
// Deliberadamente pobre em informação. A mensagem não distingue
// 'suspended' de 'blocked', não diz quem bloqueou nem por quê, e
// não expõe o nome da conta: quem chega aqui pode não ser o titular,
// e o motivo de um bloqueio é assunto entre a plataforma e o dono
// da conta — não algo para vazar numa tela pública.
//
// Os dados NÃO foram apagados. Isso é dito explicitamente porque é
// a primeira dúvida de quem vê esta tela.
// ============================================================

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';

import { branding } from '@/lib/branding';
import { OperzaLogo, OperzaWatermark } from '@/components/brand/operza-logo';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';
import { useSessionContext } from '@/hooks/use-session-context';
import { accountIsActive } from '@/lib/auth/permissions';

export default function AccountBlockedPage() {
  const router = useRouter();
  const { context, loading } = useSessionContext();

  // Se a conta foi reativada enquanto a aba estava aberta, sai
  // daqui sozinho em vez de exigir que o usuário adivinhe.
  useEffect(() => {
    if (!loading && context && accountIsActive(context)) {
      router.replace('/dashboard');
    }
  }, [loading, context, router]);

  const signOut = async () => {
    await createClient().auth.signOut();
    router.replace('/login');
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <OperzaWatermark
        size={640}
        className="pointer-events-none absolute -right-48 top-1/2 hidden -translate-y-1/2 md:block"
      />
      <div className="relative z-10 w-full max-w-md text-center">
        <div className="mb-8 flex justify-center">
          <OperzaLogo height={28} priority />
        </div>

        <div className="rounded-lg border border-border bg-card px-6 py-8">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10">
            <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>

          <h1 className="text-base font-semibold text-foreground">
            Esta conta está temporariamente indisponível
          </h1>

          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Entre em contato com o {branding.supportName} para regularizar
            o acesso.
          </p>

          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Seus dados continuam preservados. Nada foi removido e tudo
            volta a ficar disponível assim que a conta for reativada.
          </p>

          <Button
            variant="secondary"
            className="mt-6 w-full"
            onClick={signOut}
          >
            Sair
          </Button>
        </div>
      </div>
    </div>
  );
}

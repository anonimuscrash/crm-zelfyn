"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { AccountAccessAlert } from "@/components/layout/account-access-alert";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { useSessionContext } from "@/hooks/use-session-context";
import {
  accountIsActive,
  isPlatformAdmin,
} from "@/lib/auth/permissions";
import { OperzaLoading, OperzaWatermark } from "@/components/brand/operza-logo";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { context, loading: contextLoading } = useSessionContext();
  const router = useRouter();
  const pathname = usePathname();

  // A Inbox é uma tela de altura fixa com três colunas que rolam
  // independentemente. Ela não quer o padding nem o scroll do
  // container.
  //
  // Antes ela cancelava o padding com `-m-4`. Margem negativa dentro
  // de um pai com `overflow-y-auto` empurra conteúdo para fora da
  // caixa e faz a PÁGINA rolar junto — o layout deslocado que
  // aparecia ao rolar. Desligar na origem resolve; compensar não.
  const telaCheia = pathname === "/inbox";

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  // Gate de conta bloqueada.
  //
  // Isto é conveniência de navegação, NÃO a barreira de segurança:
  // as policies RLS de 045 já recusam escrita de conta inativa, então
  // um usuário que ignorasse este redirect encontraria uma API que
  // não obedece. O redirect existe para ele entender o porquê em vez
  // de ver erros crípticos em cada botão.
  //
  // Platform admins passam: eles administram a plataforma e não
  // podem ficar presos fora dela se o próprio tenant for bloqueado.
  useEffect(() => {
    if (loading || contextLoading || !user || !context) return;
    if (isPlatformAdmin(context)) return;
    if (!accountIsActive(context)) {
      router.replace("/account-blocked");
    }
  }, [loading, contextLoading, user, context, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        {/* Tela de carregamento com a marca. Sem texto "Loading..." —
            o símbolo pulsando já comunica espera, e uma palavra em
            inglês solta no meio de um produto em português é
            exatamente o tipo de aresta que denuncia um fork. */}
        <OperzaLoading />
      </div>
    );
  }

  if (!user) return null;

  // Enquanto o contexto resolve, segura a renderização se a conta
  // estiver inativa — evita o flash de dashboard antes do redirect.
  if (!contextLoading && context && !isPlatformAdmin(context) && !accountIsActive(context)) {
    return null;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main
          className={cn(
            "relative flex-1",
            telaCheia
              ? "overflow-hidden"
              : "overflow-y-auto p-4 sm:p-6"
          )}
        >
          {/* Marca d'água da identidade.
              Ancorada no canto inferior direito e recortada pela
              borda: no centro competiria com tabelas e gráficos, que
              é onde os números moram. Escondida abaixo de lg — numa
              tela estreita não há área livre para ela existir sem
              atrapalhar.

              Fora das telas de altura fixa: numa Inbox de três
              colunas ela ficaria atrás do painel de conversas, sem
              área livre para respirar. */}
          {!telaCheia ? (
            <OperzaWatermark
              size={560}
              className="pointer-events-none absolute -bottom-32 -right-24 hidden lg:block"
            />
          ) : null}

          {/* O wrapper precisa PROPAGAR a altura quando a página é de
              tela cheia.
              Sem isso, o `h-full` da Inbox resolve contra um container
              de altura automática, o conteúdo cresce além da viewport
              e o campo de mensagem sai da tela. Uma cadeia de altura
              só funciona se nenhum elo a quebrar.

              Coluna flex, não `h-full` seco: o alerta de acesso ocupa
              a altura que precisar e o resto sobra para a página. Com
              altura fixa nos dois, o alerta empurraria a Inbox para
              fora de novo assim que aparecesse.

              `min-h-0` porque um item flex tem `min-height: auto` por
              padrão e se recusa a encolher abaixo do conteúdo —
              anulando o overflow interno. */}
          <div
            className={cn(
              'relative z-10',
              telaCheia && 'flex h-full min-h-0 flex-col'
            )}
          >
            <AccountAccessAlert />
            <div className={cn(telaCheia && 'min-h-0 flex-1')}>{children}</div>
          </div>
        </main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}

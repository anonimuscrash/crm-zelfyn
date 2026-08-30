"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { UsersRound } from "lucide-react";

import { OperzaLogo, OperzaWatermark } from "@/components/brand/operza-logo";
import { branding } from "@/lib/branding";
import {
  landingPathFor,
  type SessionContext,
} from "@/lib/auth/permissions";

// `useSearchParams` opts the component out of static prerendering
// unless it sits under a Suspense boundary. We split the form into
// a child component so the outer page can prerender the chrome
// (background, card frame) while the form hydrates with the query
// string on the client.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  // Forwarded from `/join/<token>` when the visitor already has an
  // account. After a successful sign-in we send them to the join
  // page to accept rather than to /dashboard.
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("LoginPage");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    // Full-page navigation (not router.push) so the browser issues a
    // fresh top-level request that carries the just-written Supabase
    // auth cookies to the middleware gating /dashboard. A soft
    // client-side navigation can reach the protected route before the
    // server observes the new session, so the middleware bounces it
    // back to /login — which looks like the page "just refreshing"
    // instead of signing in (issue #365). Mirrors the deliberate full
    // reload the invite-accept flow already uses in join/[token].
    // Roteamento por papel (§51). Um único login para os três
    // perfis: consultamos o contexto e mandamos para o lugar certo.
    //
    // Se a RPC falhar por qualquer motivo, cai em /dashboard — o
    // shell e as policies RLS reavaliam de qualquer forma, então o
    // pior caso é um salto a mais, nunca acesso indevido.
    let destination = "/dashboard";

    if (inviteToken) {
      destination = `/join/${encodeURIComponent(inviteToken)}`;
    } else {
      const { data } = await supabase.rpc("session_context");
      const ctx = Array.isArray(data) ? data[0] : data;
      destination = landingPathFor((ctx as SessionContext) ?? null);
      if (destination === "/login") destination = "/dashboard";
    }

    window.location.href = destination;
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      {/* Presença de marca no fundo, não uma landing page.
          O símbolo em escala grande, cortado pela borda esquerda,
          dá identidade à tela sem competir com o formulário — que
          continua sendo a única coisa que o visitante precisa
          encontrar. Escondido no mobile: numa tela estreita ele
          passaria por trás dos campos. */}
      <OperzaWatermark
        size={720}
        className="pointer-events-none absolute -left-56 top-1/2 hidden -translate-y-1/2 md:block"
      />

      <Card className="relative z-10 w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          {/* Marca discreta acima do formulário. Sem ilustração, sem
              frase de marketing — o login é uma porta, não uma landing
              page. Quando o visitante chega por um convite mostramos o
              ícone de equipe: ali o contexto ("você foi convidado") é
              mais informativo que repetir a logo. */}
          <div className="mb-3 flex h-12 items-center justify-center">
            {inviteToken ? (
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                <UsersRound className="h-6 w-6 text-primary" />
              </span>
            ) : (
              <OperzaLogo height={30} priority />
            )}
          </div>
          <CardTitle className="text-xl text-foreground">
            {inviteToken ? t('titleAccept') : t('titleWelcome')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {inviteToken
              ? t('descAccept')
              : t('descWelcome')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                {t('emailLabel')}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t('emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-muted-foreground">
                  {t('passwordLabel')}
                </Label>
                <Link
                  href="/forgot-password"
                  className="text-sm text-primary hover:text-primary/80"
                >
                  {t('forgotPassword')}
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                placeholder={t('passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? t('signingIn') : t('signIn')}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t('noAccount')}{" "}
            <Link
              href={
                inviteToken
                  ? `/signup?invite=${encodeURIComponent(inviteToken)}`
                  : "/signup"
              }
              className="text-primary hover:text-primary/80"
            >
              {t('createAccount')}
            </Link>
          </p>
        </CardContent>
      </Card>

      {/* Uma linha descrevendo o que o produto é. Não é slogan de
          venda: quem chega aqui já é cliente. Serve para confirmar
          que está no lugar certo. */}
      <p className="absolute bottom-6 left-0 right-0 z-10 text-center text-xs text-muted-foreground">
        {branding.name} · {branding.tagline}
      </p>
    </div>
  );
}

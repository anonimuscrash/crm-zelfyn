'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCan } from '@/hooks/use-can';
import type { SellerPerformanceRow } from '@/lib/commerce/types';

/**
 * Emissão do relatório em PDF.
 *
 * O download é feito por `fetch` + blob, e não por um link direto
 * para a rota. Um `<a href>` seria menos código, mas quando a rota
 * falha o navegador sai da página e mostra o JSON do erro cru —
 * o usuário perde o filtro de período que tinha montado. Assim o
 * erro vira um toast e a tela não se mexe.
 */
export function ReportPdfButton({
  periodQueryString,
  sellers,
  disabled,
}: {
  /** Query string do período, já montada pelo `periodQuery`. */
  periodQueryString: string;
  /** Vendedores do período — vem do payload de relatórios, sem fetch extra. */
  sellers: SellerPerformanceRow[];
  disabled?: boolean;
}) {
  const t = useTranslations('Reports');
  const [baixando, setBaixando] = useState<string | null>(null);
  const isMaster = useCan('manage-members');

  // Só atendentes identificáveis entram no menu. Vendas sem
  // vendedor atribuído aparecem no ranking como uma linha
  // agregada, mas não têm relatório individual para emitir.
  const atendentes = sellers.filter((s) => s.seller_user_id);

  async function baixar(sellerId: string | null, rotulo: string) {
    const chave = sellerId ?? 'platform';
    setBaixando(chave);
    try {
      const qs = new URLSearchParams(periodQueryString);
      if (sellerId) qs.set('sellerId', sellerId);

      const res = await fetch(`/api/commerce/reports/pdf?${qs.toString()}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error || t('pdfError'));
      }

      const blob = await res.blob();

      // Nome do arquivo vindo do Content-Disposition da rota, para
      // a lógica de nomenclatura viver num lugar só.
      const disposition = res.headers.get('Content-Disposition') || '';
      const casado = /filename="([^"]+)"/.exec(disposition);
      const nome = casado?.[1] || 'relatorio.pdf';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nome;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Sem o revoke o blob fica preso na memória da aba até o
      // reload — alguns relatórios seguidos e são vários MB parados.
      URL.revokeObjectURL(url);

      toast.success(t('pdfReady', { name: rotulo }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('pdfError'));
    } finally {
      setBaixando(null);
    }
  }

  const ocupado = baixando !== null;

  // Sem permissão de master não há o que escolher: um único botão
  // que emite o relatório da conta.
  if (!isMaster) {
    return (
      <Button
        variant="outline"
        onClick={() => baixar(null, t('pdfPlatform'))}
        disabled={disabled || ocupado}
      >
        {ocupado ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Download className="size-4" />
        )}
        {t('pdfDownload')}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" />}
        disabled={disabled || ocupado}
      >
        {ocupado ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Download className="size-4" />
        )}
        {t('pdfDownload')}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onClick={() => baixar(null, t('pdfPlatform'))}>
          <FileText className="size-4" />
          {t('pdfPlatform')}
        </DropdownMenuItem>

        {atendentes.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('pdfBySeller')}</DropdownMenuLabel>
            {atendentes.map((s) => (
              <DropdownMenuItem
                key={s.seller_user_id}
                onClick={() => baixar(s.seller_user_id!, s.seller_name)}
              >
                <span className="truncate">{s.seller_name}</span>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

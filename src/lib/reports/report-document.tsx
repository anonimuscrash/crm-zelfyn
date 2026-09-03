// ============================================================
// Documento PDF do relatório.
//
// POR QUE NÃO PUPPETEER
// ---------------------
// A saída em PDF costuma ser feita abrindo a página num Chromium
// headless e mandando imprimir. Funciona, e traz o CSS de graça,
// mas arrasta o Chromium inteiro para a imagem Docker e cada
// requisição sobe um browser — algumas centenas de MB de RAM por
// relatório. Numa VPS pequena, o primeiro relatório grande derruba
// a aplicação junto.
//
// O @react-pdf/renderer desenha em Node puro. Custa perder o CSS
// (o layout aqui é reescrito com o subconjunto dele) e ganha um
// processo que não depende de browser nem de fonte instalada no
// sistema.
//
// FONTE
// -----
// Helvetica embutida, não a Inter da marca. As 14 fontes base do
// PDF não precisam ser embarcadas no arquivo e cobrem o Latin-1
// inteiro — ou seja, acento e cedilha saem corretos sem carregar
// um TTF de 300 KB a cada emissão. A marca aparece no cabeçalho,
// que é onde ela é lida.
// ============================================================

import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
} from '@react-pdf/renderer';

import type { ReportModel, ReportTable } from './report-data';

const COR = {
  tinta: '#0f172a',
  suave: '#64748b',
  linha: '#e2e8f0',
  faixa: '#f8fafc',
  marca: '#2563eb',
};

const s = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 56,
    paddingHorizontal: 40,
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: COR.tinta,
  },

  cabecalho: {
    borderBottomWidth: 2,
    borderBottomColor: COR.marca,
    paddingBottom: 10,
    marginBottom: 18,
  },
  marca: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: COR.marca },
  titulo: { fontSize: 17, fontFamily: 'Helvetica-Bold', marginTop: 8 },
  subtitulo: { fontSize: 11, color: COR.suave, marginTop: 3 },
  meta: { fontSize: 8.5, color: COR.suave, marginTop: 6 },

  secao: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginBottom: 7 },
  bloco: { marginBottom: 18 },

  // Resumo em duas colunas: rótulo à esquerda, valor à direita.
  resumoLinha: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3.5,
    borderBottomWidth: 0.5,
    borderBottomColor: COR.linha,
  },
  resumoRotulo: { color: COR.suave },
  resumoValor: { fontFamily: 'Helvetica-Bold' },
  resumoDestaque: { fontFamily: 'Helvetica-Bold', color: COR.marca, fontSize: 10.5 },

  thead: {
    flexDirection: 'row',
    backgroundColor: COR.faixa,
    borderBottomWidth: 1,
    borderBottomColor: COR.linha,
    paddingVertical: 5,
    paddingHorizontal: 4,
  },
  th: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: COR.suave },
  tr: {
    flexDirection: 'row',
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: COR.linha,
  },
  td: { fontSize: 8.5 },
  vazio: { fontSize: 9, color: COR.suave, fontStyle: 'italic', paddingVertical: 8 },

  rodape: {
    position: 'absolute',
    bottom: 26,
    left: 40,
    right: 40,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 0.5,
    borderTopColor: COR.linha,
    paddingTop: 6,
    fontSize: 7.5,
    color: COR.suave,
  },
});

function Tabela({ tabela }: { tabela: ReportTable }) {
  const total = tabela.widths.reduce((a, b) => a + b, 0) || 1;
  const pct = tabela.widths.map((w) => `${(w / total) * 100}%`);

  // Alinhamento por coluna, tirado do tipo do dado e não da posição.
  // Antes vinha de `i === 0 ? left : right`, o que jogava "SKU" para
  // a direita enquanto os códigos abaixo ficavam à esquerda — título
  // e valores desencontrados na mesma coluna.
  const alinhamento = tabela.columns.map<'left' | 'right'>((_, i) => {
    const numerica = tabela.rows[0]?.[i]?.numeric ?? i !== 0;
    return numerica ? 'right' : 'left';
  });

  return (
    // `wrap` deixa a tabela quebrar entre páginas; `fixed` no
    // cabeçalho faz os títulos das colunas se repetirem no topo de
    // cada página nova. Sem isso, a segunda página de um ranking
    // longo vira uma grade de números sem legenda.
    //
    // `minPresenceAhead` conserta o efeito colateral disso. Sem ele,
    // uma tabela que começa a 30pt do fim da página desenha ali o
    // cabeçalho, não cabe nenhuma linha, e o cabeçalho reaparece na
    // página seguinte — sobra um cabeçalho órfão no rodapé. O valor
    // cobre título, cabeçalho e três linhas: se não couber isso, o
    // bloco inteiro desce.
    <View style={s.bloco} wrap minPresenceAhead={90}>
      <Text style={s.secao}>{tabela.title}</Text>

      {tabela.rows.length === 0 ? (
        <Text style={s.vazio}>{tabela.emptyText}</Text>
      ) : (
        <>
          <View style={s.thead} fixed>
            {tabela.columns.map((c, i) => (
              <Text
                key={c}
                style={[
                  s.th,
                  {
                    width: pct[i],
                    textAlign: alinhamento[i],
                    // Sem esta folga a última palavra de uma célula
                    // encosta na coluna seguinte — texto longo não
                    // tem como saber onde a coluna vizinha começa.
                    // A última coluna fica sem, para o alinhamento
                    // à direita bater com a margem da página.
                    paddingRight: i === tabela.columns.length - 1 ? 0 : 6,
                  },
                ]}
              >
                {c}
              </Text>
            ))}
          </View>

          {tabela.rows.map((linha, li) => (
            <View key={li} style={s.tr} wrap={false}>
              {linha.map((celula, ci) => (
                <Text
                  key={ci}
                  style={[
                    s.td,
                    {
                      width: pct[ci],
                      textAlign: alinhamento[ci],
                      paddingRight: ci === linha.length - 1 ? 0 : 6,
                    },
                  ]}
                >
                  {celula.text}
                </Text>
              ))}
            </View>
          ))}
        </>
      )}
    </View>
  );
}

export function ReportDocument({ model }: { model: ReportModel }) {
  return (
    <Document
      title={`${model.title} — ${model.subtitle}`}
      author="Operza"
      creator="Operza"
    >
      <Page size="A4" style={s.page}>
        <View style={s.cabecalho}>
          <Text style={s.marca}>Operza</Text>
          <Text style={s.titulo}>{model.title}</Text>
          <Text style={s.subtitulo}>{model.subtitle}</Text>
          <Text style={s.meta}>
            Período: {model.periodLabel} · {model.generatedLabel}
          </Text>
        </View>

        <View style={s.bloco}>
          <Text style={s.secao}>
            {model.scope === 'seller' ? 'Resumo de vendas' : 'Resultado do período'}
          </Text>
          {model.summary.map((item) => (
            <View key={item.label} style={s.resumoLinha}>
              <Text style={s.resumoRotulo}>{item.label}</Text>
              <Text style={item.strong ? s.resumoDestaque : s.resumoValor}>
                {item.value}
              </Text>
            </View>
          ))}
        </View>

        {model.tables.map((tabela) => (
          <Tabela key={tabela.title} tabela={tabela} />
        ))}

        <View style={s.rodape} fixed>
          <Text>
            {model.title} · {model.periodLabel}
          </Text>
          <Text
            render={({ pageNumber, totalPages }) =>
              `${pageNumber} de ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}

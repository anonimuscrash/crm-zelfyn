import { describe, expect, it } from 'vitest';

import { sortProductRanking, sortTeam } from './analytics.repo';
import type { ProductRankingRow, TeamMemberRow } from './types';

const membro = (over: Partial<TeamMemberRow>): TeamMemberRow => ({
  user_id: 'u',
  full_name: 'X',
  email: 'x@x.com',
  avatar_url: null,
  account_role: 'agent',
  joined_at: '2026-01-01T00:00:00Z',
  last_seen_at: null,
  order_count: 0,
  net_revenue_cents: 0,
  gross_profit_cents: 0,
  avg_ticket_cents: 0,
  units_sold: 0,
  discount_cents: 0,
  today_order_count: 0,
  today_net_revenue_cents: 0,
  ...over,
});

const joao = membro({
  user_id: 'joao',
  full_name: 'João',
  order_count: 10,
  net_revenue_cents: 100_000,
  gross_profit_cents: 20_000, // margem 20%
  avg_ticket_cents: 10_000,
});

const maria = membro({
  user_id: 'maria',
  full_name: 'Maria',
  order_count: 4,
  net_revenue_cents: 60_000,
  gross_profit_cents: 30_000, // margem 50%
  avg_ticket_cents: 15_000,
});

const semVenda = membro({ user_id: 'novo', full_name: 'Novo' });

describe('sortTeam', () => {
  const equipe = [joao, maria, semVenda];

  it('ordena por faturamento', () => {
    expect(sortTeam(equipe, 'revenue').map((m) => m.user_id)).toEqual([
      'joao',
      'maria',
      'novo',
    ]);
  });

  it('ordena por lucro — quem fatura mais não é quem lucra mais', () => {
    // O caso que justifica ter as duas ordenações: João fatura 40%
    // mais e lucra 33% menos.
    expect(sortTeam(equipe, 'profit').map((m) => m.user_id)).toEqual([
      'maria',
      'joao',
      'novo',
    ]);
  });

  it('ordena por número de pedidos', () => {
    expect(sortTeam(equipe, 'orders').map((m) => m.user_id)).toEqual([
      'joao',
      'maria',
      'novo',
    ]);
  });

  it('ordena por ticket médio', () => {
    expect(sortTeam(equipe, 'ticket').map((m) => m.user_id)).toEqual([
      'maria',
      'joao',
      'novo',
    ]);
  });

  it('ordena por margem', () => {
    expect(sortTeam(equipe, 'margin').map((m) => m.user_id)).toEqual([
      'maria',
      'joao',
      'novo',
    ]);
  });

  it('trata quem não vendeu como margem zero, sem dividir por zero', () => {
    const ordenado = sortTeam([semVenda], 'margin');
    expect(ordenado).toHaveLength(1);
    expect(Number.isNaN(ordenado[0].net_revenue_cents)).toBe(false);
  });

  it('não muta o array recebido', () => {
    const original = [joao, maria];
    const copia = [...original];
    sortTeam(original, 'profit');
    expect(original).toEqual(copia);
  });

  it('devolve todos os membros, inclusive os sem venda', () => {
    // Um vendedor que não vendeu é justamente a linha que o dono
    // precisa enxergar.
    expect(sortTeam(equipe, 'revenue')).toHaveLength(3);
  });
});

const produto = (over: Partial<ProductRankingRow>): ProductRankingRow => ({
  product_id: 'p',
  product_name: 'P',
  product_sku: null,
  units_sold: 0,
  order_count: 0,
  gross_cents: 0,
  discount_cents: 0,
  net_revenue_cents: 0,
  cogs_cents: 0,
  gross_profit_cents: 0,
  avg_ticket_cents: 0,
  ...over,
});

describe('sortProductRanking', () => {
  const a = produto({
    product_id: 'a',
    units_sold: 100,
    net_revenue_cents: 50_000,
    gross_profit_cents: 5_000, // 10%
    discount_cents: 9_000,
  });
  const b = produto({
    product_id: 'b',
    units_sold: 10,
    net_revenue_cents: 80_000,
    gross_profit_cents: 40_000, // 50%
    discount_cents: 1_000,
  });

  it('separa mais vendido de mais lucrativo', () => {
    expect(sortProductRanking([a, b], 'units')[0].product_id).toBe('a');
    expect(sortProductRanking([a, b], 'profit')[0].product_id).toBe('b');
    expect(sortProductRanking([a, b], 'revenue')[0].product_id).toBe('b');
  });

  it('ordena margem nos dois sentidos', () => {
    expect(sortProductRanking([a, b], 'margin')[0].product_id).toBe('b');
    expect(sortProductRanking([a, b], 'marginAsc')[0].product_id).toBe('a');
  });

  it('ordena por desconto concedido', () => {
    expect(sortProductRanking([a, b], 'discount')[0].product_id).toBe('a');
  });

  it('não muta o array recebido', () => {
    const original = [a, b];
    const copia = [...original];
    sortProductRanking(original, 'profit');
    expect(original).toEqual(copia);
  });
});

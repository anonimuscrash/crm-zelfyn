import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isOrderStatus,
  isRevenueStatus,
  ORDER_STATUS_META,
  ORDER_STATUSES,
  REVENUE_STATUSES,
} from './order-status';

// ------------------------------------------------------------
// The status vocabulary lives in two places by necessity: the CHECK
// constraint (so the database rejects garbage) and this module (so
// the Kanban can render columns). Two copies of one list is a drift
// hazard — add 'on_hold' to the SQL, forget the TS, and the board
// silently drops a column's worth of orders with no error anywhere.
//
// These tests read the migration and assert the two agree.
// ------------------------------------------------------------

const MIGRATION = join(
  process.cwd(),
  'supabase',
  'migrations',
  '040_commerce_core.sql'
);

function readMigration(): string {
  return readFileSync(MIGRATION, 'utf8');
}

/** Pull the quoted values out of the orders.status CHECK constraint. */
function statusesFromCheckConstraint(sql: string): string[] {
  const match = /status TEXT NOT NULL DEFAULT 'new' CHECK \(status IN \(([\s\S]*?)\)\)/.exec(
    sql
  );
  if (!match) throw new Error('orders.status CHECK constraint not found');
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** Pull the quoted values out of order_status_is_revenue(). */
function statusesFromRevenueFunction(sql: string): string[] {
  const match = /CREATE OR REPLACE FUNCTION order_status_is_revenue[\s\S]*?SELECT p_status IN \(([\s\S]*?)\);/.exec(
    sql
  );
  if (!match) throw new Error('order_status_is_revenue() not found');
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('order status ↔ SQL parity', () => {
  it('ORDER_STATUSES matches the orders.status CHECK constraint', () => {
    const fromSql = statusesFromCheckConstraint(readMigration());
    expect([...fromSql].sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('REVENUE_STATUSES matches order_status_is_revenue()', () => {
    const fromSql = statusesFromRevenueFunction(readMigration());
    expect([...fromSql].sort()).toEqual([...REVENUE_STATUSES].sort());
  });

  it('every status has render metadata — no column can appear unstyled', () => {
    for (const status of ORDER_STATUSES) {
      expect(ORDER_STATUS_META[status]).toBeDefined();
      expect(ORDER_STATUS_META[status].labelKey).toBeTruthy();
    }
  });
});

describe('isRevenueStatus', () => {
  it('counts the fulfilment pipeline as revenue', () => {
    expect(isRevenueStatus('new')).toBe(true);
    expect(isRevenueStatus('paid')).toBe(true);
    expect(isRevenueStatus('shipped')).toBe(true);
    expect(isRevenueStatus('completed')).toBe(true);
    expect(isRevenueStatus('problem')).toBe(true);
  });

  it('excludes cancelled and refunded — they stay queryable but earn nothing', () => {
    expect(isRevenueStatus('cancelled')).toBe(false);
    expect(isRevenueStatus('refunded')).toBe(false);
  });

  it('partitions the full vocabulary with nothing left over', () => {
    const revenue = ORDER_STATUSES.filter(isRevenueStatus);
    const nonRevenue = ORDER_STATUSES.filter((s) => !isRevenueStatus(s));
    expect(revenue.length + nonRevenue.length).toBe(ORDER_STATUSES.length);
    expect(nonRevenue).toEqual(['cancelled', 'refunded']);
  });
});

describe('isOrderStatus', () => {
  it('narrows valid strings and rejects everything else', () => {
    expect(isOrderStatus('paid')).toBe(true);
    expect(isOrderStatus('on_hold')).toBe(false);
    expect(isOrderStatus('')).toBe(false);
    expect(isOrderStatus(null)).toBe(false);
    expect(isOrderStatus(42)).toBe(false);
  });
});

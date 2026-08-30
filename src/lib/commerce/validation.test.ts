import { describe, expect, it } from 'vitest';

import {
  parseCreateOrderInput,
  parseExpenseInput,
  parseOrderPatch,
  parseProductInput,
  requiredCents,
  ValidationError,
} from './validation';

const UUID = '11111111-2222-4333-8444-555555555555';

describe('requiredCents', () => {
  it('accepts non-negative integers', () => {
    expect(requiredCents(0, 'x')).toBe(0);
    expect(requiredCents(1999, 'x')).toBe(1999);
    expect(requiredCents('1999', 'x')).toBe(1999);
  });

  it('rejects fractional cents — the float trap the whole design avoids', () => {
    expect(() => requiredCents(19.99, 'x')).toThrow(ValidationError);
  });

  it('rejects negatives, NaN, and implausible magnitudes', () => {
    expect(() => requiredCents(-1, 'x')).toThrow(ValidationError);
    expect(() => requiredCents(NaN, 'x')).toThrow(ValidationError);
    expect(() => requiredCents('abc', 'x')).toThrow(ValidationError);
    expect(() => requiredCents(1e15, 'x')).toThrow(ValidationError);
  });
});

describe('parseProductInput', () => {
  it('normalises a valid product', () => {
    const p = parseProductInput({
      name: '  Camiseta  ',
      sku: 'CAM-01',
      unit_cost_cents: 2000,
      unit_price_cents: 5990,
      category: '',
    });
    expect(p.name).toBe('Camiseta');
    expect(p.sku).toBe('CAM-01');
    expect(p.category).toBeNull();
    expect(p.is_active).toBe(true);
  });

  it('defaults missing money to zero rather than undefined', () => {
    const p = parseProductInput({ name: 'X' });
    expect(p.unit_cost_cents).toBe(0);
    expect(p.unit_price_cents).toBe(0);
  });

  it('requires a name', () => {
    expect(() => parseProductInput({ name: '   ' })).toThrow(ValidationError);
    expect(() => parseProductInput({})).toThrow(ValidationError);
  });

  it('distinguishes untracked stock (null) from sold out (0)', () => {
    expect(parseProductInput({ name: 'X' }).stock_quantity).toBeNull();
    expect(
      parseProductInput({ name: 'X', stock_quantity: 0 }).stock_quantity
    ).toBe(0);
  });

  it('rejects a negative or fractional stock count', () => {
    expect(() => parseProductInput({ name: 'X', stock_quantity: -1 })).toThrow(
      ValidationError
    );
    expect(() => parseProductInput({ name: 'X', stock_quantity: 1.5 })).toThrow(
      ValidationError
    );
  });
});

describe('parseCreateOrderInput', () => {
  const base = {
    contact_id: UUID,
    items: [{ product_id: UUID, quantity: 2 }],
  };

  it('accepts a minimal valid order', () => {
    const o = parseCreateOrderInput(base);
    expect(o.items).toHaveLength(1);
    expect(o.items[0].quantity).toBe(2);
    expect(o.status).toBe('new');
    expect(o.discount_kind).toBe('fixed');
  });

  it('requires at least one item', () => {
    expect(() => parseCreateOrderInput({ items: [] })).toThrow(ValidationError);
    expect(() => parseCreateOrderInput({})).toThrow(ValidationError);
  });

  it('requires each line to identify what was sold', () => {
    expect(() => parseCreateOrderInput({ items: [{ quantity: 1 }] })).toThrow(
      /product_id or a product_name/
    );
  });

  it('accepts a free-text line with no product record', () => {
    const o = parseCreateOrderInput({
      items: [
        { product_name: 'Serviço avulso', unit_price_cents: 5000, quantity: 1 },
      ],
    });
    expect(o.items[0].product_name).toBe('Serviço avulso');
    expect(o.items[0].product_id).toBeNull();
  });

  it('rejects an unknown status', () => {
    expect(() =>
      parseCreateOrderInput({ ...base, status: 'on_hold' })
    ).toThrow(ValidationError);
  });

  it('rejects a percentage discount above 100% instead of clamping it', () => {
    expect(() =>
      parseCreateOrderInput({
        ...base,
        discount_kind: 'percent',
        discount_value: 12_000,
      })
    ).toThrow(/cannot exceed 100%/);
  });

  it('rejects a non-positive quantity', () => {
    expect(() =>
      parseCreateOrderInput({ items: [{ product_id: UUID, quantity: 0 }] })
    ).toThrow(ValidationError);
    expect(() =>
      parseCreateOrderInput({ items: [{ product_id: UUID, quantity: -3 }] })
    ).toThrow(ValidationError);
  });

  it('rejects a malformed UUID rather than passing it to Postgres', () => {
    expect(() =>
      parseCreateOrderInput({ ...base, contact_id: 'not-a-uuid' })
    ).toThrow(ValidationError);
  });

  it('validates extra costs', () => {
    const o = parseCreateOrderInput({
      ...base,
      extra_costs: [{ label: 'Embalagem', amount_cents: 500 }],
    });
    expect(o.extra_costs).toEqual([
      { label: 'Embalagem', amount_cents: 500 },
    ]);

    expect(() =>
      parseCreateOrderInput({
        ...base,
        extra_costs: [{ label: '', amount_cents: 500 }],
      })
    ).toThrow(ValidationError);
  });
});

describe('parseOrderPatch', () => {
  it('accepts a status-only patch — the Kanban drag payload', () => {
    expect(parseOrderPatch({ status: 'shipped' })).toEqual({
      status: 'shipped',
    });
  });

  it('REFUSES to let a client write a derived total', () => {
    // The whole point of computing totals in the database: a caller
    // must not be able to book a fabricated profit.
    expect(() => parseOrderPatch({ gross_profit_cents: 999_999 })).toThrow(
      /derived/
    );
    expect(() => parseOrderPatch({ net_revenue_cents: 1 })).toThrow(/derived/);
    expect(() => parseOrderPatch({ order_number: 1 })).toThrow(/derived/);
    expect(() => parseOrderPatch({ account_id: UUID })).toThrow(/derived/);
  });

  it('rejects an empty patch', () => {
    expect(() => parseOrderPatch({})).toThrow(ValidationError);
  });

  it('keeps discount kind and value together', () => {
    const patch = parseOrderPatch({
      discount_kind: 'percent',
      discount_value: 1000,
    });
    expect(patch).toEqual({ discount_kind: 'percent', discount_value: 1000 });
  });

  it('allows clearing a nullable field explicitly', () => {
    expect(parseOrderPatch({ tracking_code: null })).toEqual({
      tracking_code: null,
    });
  });
});

describe('parseExpenseInput', () => {
  it('accepts a valid expense', () => {
    const e = parseExpenseInput({
      description: 'Anúncios Meta',
      amount_cents: 820_000,
      category_id: UUID,
      incurred_on: '2026-05-14',
    });
    expect(e.description).toBe('Anúncios Meta');
    expect(e.amount_cents).toBe(820_000);
    expect(e.is_recurring).toBe(false);
  });

  it('defaults the date to today when omitted', () => {
    const e = parseExpenseInput({ description: 'X', amount_cents: 100 });
    expect(e.incurred_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects a malformed date', () => {
    expect(() =>
      parseExpenseInput({
        description: 'X',
        amount_cents: 100,
        incurred_on: '14/05/2026',
      })
    ).toThrow(ValidationError);
  });

  it('requires an interval when the expense is marked recurring', () => {
    expect(() =>
      parseExpenseInput({
        description: 'Aluguel',
        amount_cents: 100,
        is_recurring: true,
      })
    ).toThrow(/recurrence interval/);
  });

  it('rejects an unknown recurrence interval', () => {
    expect(() =>
      parseExpenseInput({
        description: 'X',
        amount_cents: 100,
        recurrence: 'daily',
      })
    ).toThrow(ValidationError);
  });
});

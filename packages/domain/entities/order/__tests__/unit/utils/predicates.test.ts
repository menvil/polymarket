/**
 * Тесты для utils/predicates.ts
 */

import { Quantity, Price } from '@polymarket/value-objects';
import Decimal from 'decimal.js';
import {
  isFilled,
  isOpen,
  isPending,
  isCanceled,
  isRejected,
  isExpired,
  isPartiallyFilled,
  isTerminal,
  isActive,
  canModify,
  isFailed,
  isSuccessful,
} from '../../../src/utils/predicates';
import { OrderFill } from '../../../src/value-objects/OrderFill';
import { asFillId } from '@polymarket/ids';
import type { OrderStatus } from '../../../src/value-objects/OrderStatus';

// ──────────────── Вспомогательные значения ────────────────

const FILL_1 = asFillId('fill-1')!;
const SIZE_100 = Quantity.of(new Decimal('100'));
const PRICE_065 = Price.of(new Decimal('0.65'));

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(String((r as any).error?.message));
  return (r as { ok: true; value: T }).value;
}

const FILL_PARTIAL = unwrap(OrderFill.create(
  Quantity.of(new Decimal('30')),
  PRICE_065,
  [FILL_1],
  SIZE_100
));

const FILL_FULL = unwrap(OrderFill.create(
  SIZE_100,
  PRICE_065,
  [FILL_1],
  SIZE_100
));

const TERMINAL_STATUSES: OrderStatus[] = ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'];
const ACTIVE_STATUSES: OrderStatus[] = ['PENDING', 'OPEN', 'PARTIALLY_FILLED'];
const ALL_STATUSES: OrderStatus[] = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES];

// ──────────────── Простые предикаты ────────────────

describe('isFilled()', () => {
  it('true только для FILLED', () => {
    expect(isFilled('FILLED')).toBe(true);
    ALL_STATUSES.filter(s => s !== 'FILLED').forEach(s => expect(isFilled(s)).toBe(false));
  });
});

describe('isOpen()', () => {
  it('true только для OPEN', () => {
    expect(isOpen('OPEN')).toBe(true);
    ALL_STATUSES.filter(s => s !== 'OPEN').forEach(s => expect(isOpen(s)).toBe(false));
  });
});

describe('isPending()', () => {
  it('true только для PENDING', () => {
    expect(isPending('PENDING')).toBe(true);
    ALL_STATUSES.filter(s => s !== 'PENDING').forEach(s => expect(isPending(s)).toBe(false));
  });
});

describe('isCanceled()', () => {
  it('true только для CANCELED', () => {
    expect(isCanceled('CANCELED')).toBe(true);
    ALL_STATUSES.filter(s => s !== 'CANCELED').forEach(s => expect(isCanceled(s)).toBe(false));
  });
});

describe('isRejected()', () => {
  it('true только для REJECTED', () => {
    expect(isRejected('REJECTED')).toBe(true);
    ALL_STATUSES.filter(s => s !== 'REJECTED').forEach(s => expect(isRejected(s)).toBe(false));
  });
});

describe('isExpired()', () => {
  it('true только для EXPIRED', () => {
    expect(isExpired('EXPIRED')).toBe(true);
    ALL_STATUSES.filter(s => s !== 'EXPIRED').forEach(s => expect(isExpired(s)).toBe(false));
  });
});

// ──────────────── isPartiallyFilled ────────────────

describe('isPartiallyFilled()', () => {
  it('true когда статус PARTIALLY_FILLED и fill частичный', () => {
    expect(isPartiallyFilled('PARTIALLY_FILLED', FILL_PARTIAL, SIZE_100)).toBe(true);
  });

  it('false когда статус PARTIALLY_FILLED но fill пустой', () => {
    expect(isPartiallyFilled('PARTIALLY_FILLED', OrderFill.empty(), SIZE_100)).toBe(false);
  });

  it('false когда статус PARTIALLY_FILLED но fill полный', () => {
    expect(isPartiallyFilled('PARTIALLY_FILLED', FILL_FULL, SIZE_100)).toBe(false);
  });

  it.each(ALL_STATUSES.filter(s => s !== 'PARTIALLY_FILLED'))(
    'false для статуса %s даже если fill частичный',
    (status) => expect(isPartiallyFilled(status, FILL_PARTIAL, SIZE_100)).toBe(false)
  );
});

// ──────────────── isTerminal ────────────────

describe('isTerminal()', () => {
  it.each(TERMINAL_STATUSES)('true для %s', (s) => expect(isTerminal(s)).toBe(true));
  it.each(ACTIVE_STATUSES)('false для %s', (s) => expect(isTerminal(s)).toBe(false));
});

// ──────────────── isActive ────────────────

describe('isActive()', () => {
  it.each(ACTIVE_STATUSES)('true для %s', (s) => expect(isActive(s)).toBe(true));
  it.each(TERMINAL_STATUSES)('false для %s', (s) => expect(isActive(s)).toBe(false));
});

// ──────────────── canModify ────────────────

describe('canModify()', () => {
  it('true только для OPEN', () => {
    expect(canModify('OPEN')).toBe(true);
  });

  it.each(ALL_STATUSES.filter(s => s !== 'OPEN'))(
    'false для %s',
    (status) => expect(canModify(status)).toBe(false)
  );
});

// ──────────────── isFailed ────────────────

describe('isFailed()', () => {
  it.each(['REJECTED', 'CANCELED', 'EXPIRED'] as OrderStatus[])(
    'true для %s',
    (s) => expect(isFailed(s)).toBe(true)
  );

  it.each(['PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED'] as OrderStatus[])(
    'false для %s',
    (s) => expect(isFailed(s)).toBe(false)
  );
});

// ──────────────── isSuccessful ────────────────

describe('isSuccessful()', () => {
  it('true только для FILLED', () => {
    expect(isSuccessful('FILLED')).toBe(true);
    ALL_STATUSES.filter(s => s !== 'FILLED').forEach(s => expect(isSuccessful(s)).toBe(false));
  });
});

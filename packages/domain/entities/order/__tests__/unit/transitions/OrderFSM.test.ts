/**
 * Тесты для OrderFSM — чистый валидатор переходов состояния
 */

import { OrderFSM } from '../../../src/transitions/OrderFSM';
import type { OrderChange } from '../../../src/types/OrderChange';
import type { OrderStatus } from '../../../src/value-objects/OrderStatus';
import {
  asOrderId,
  asFillId,
  parseConditionId,
  parseOutcomeKey,
  KnownChainIds,
  KnownOnChainProtocols,
} from '@polymarket/ids';
import type { AssetId } from '@polymarket/ids';
import { Price, Quantity } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// ──────────────── Фикстуры ────────────────

const ASSET: AssetId = {
  type: 'OUTCOME_TOKEN',
  conditionRef: {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: parseConditionId('0x' + 'a'.repeat(64))!,
  },
  outcomeKey: parseOutcomeKey('YES')!,
};

const ORDER_ID = asOrderId('order-fsm-1')!;
const FILL_ID = asFillId('fill-fsm-1')!;

const ALL_STATUSES: OrderStatus[] = [
  'PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED',
];

function makeFillChange(): OrderChange {
  return {
    type: 'FILL_APPLIED',
    fill: {
      id: FILL_ID,
      orderId: ORDER_ID,
      asset: ASSET,
      side: 'BUY',
      size: Quantity.of(new Decimal('30')),
      price: Price.of(new Decimal('0.65')),
    },
  };
}

// ──────────────── ACCEPTED ────────────────

describe('OrderFSM.transition() — ACCEPTED', () => {
  it('Ok для PENDING', () => {
    const result = OrderFSM.transition('PENDING', { type: 'ACCEPTED' });
    expect(result.ok).toBe(true);
  });

  it.each(ALL_STATUSES.filter(s => s !== 'PENDING'))(
    'Err для %s',
    (status) => expect(OrderFSM.transition(status, { type: 'ACCEPTED' }).ok).toBe(false)
  );

  it('сообщение содержит статус', () => {
    const result = OrderFSM.transition('OPEN', { type: 'ACCEPTED' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('OPEN');
  });
});

// ──────────────── REJECTED ────────────────

describe('OrderFSM.transition() — REJECTED', () => {
  const change: OrderChange = { type: 'REJECTED', reason: 'Bad price' };

  it('Ok для PENDING', () => {
    expect(OrderFSM.transition('PENDING', change).ok).toBe(true);
  });

  it.each(ALL_STATUSES.filter(s => s !== 'PENDING'))(
    'Err для %s',
    (status) => expect(OrderFSM.transition(status, change).ok).toBe(false)
  );
});

// ──────────────── CANCELLED ────────────────

describe('OrderFSM.transition() — CANCELLED', () => {
  const change: OrderChange = { type: 'CANCELLED', reason: 'User request' };

  it('Ok для OPEN', () => {
    expect(OrderFSM.transition('OPEN', change).ok).toBe(true);
  });

  it('Ok для PARTIALLY_FILLED', () => {
    expect(OrderFSM.transition('PARTIALLY_FILLED', change).ok).toBe(true);
  });

  it.each(['PENDING', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'] as OrderStatus[])(
    'Err для %s',
    (status) => expect(OrderFSM.transition(status, change).ok).toBe(false)
  );
});

// ──────────────── EXPIRED ────────────────

describe('OrderFSM.transition() — EXPIRED', () => {
  const change: OrderChange = { type: 'EXPIRED' };

  it('Ok для OPEN', () => {
    expect(OrderFSM.transition('OPEN', change).ok).toBe(true);
  });

  it('Ok для PARTIALLY_FILLED', () => {
    expect(OrderFSM.transition('PARTIALLY_FILLED', change).ok).toBe(true);
  });

  it.each(['PENDING', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'] as OrderStatus[])(
    'Err для %s',
    (status) => expect(OrderFSM.transition(status, change).ok).toBe(false)
  );
});

// ──────────────── FILL_APPLIED ────────────────

describe('OrderFSM.transition() — FILL_APPLIED', () => {
  it('Ok для OPEN', () => {
    expect(OrderFSM.transition('OPEN', makeFillChange()).ok).toBe(true);
  });

  it('Ok для PARTIALLY_FILLED', () => {
    expect(OrderFSM.transition('PARTIALLY_FILLED', makeFillChange()).ok).toBe(true);
  });

  it.each(['PENDING', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'] as OrderStatus[])(
    'Err для %s',
    (status) => expect(OrderFSM.transition(status, makeFillChange()).ok).toBe(false)
  );

  it('сообщение содержит статус', () => {
    const result = OrderFSM.transition('PENDING', makeFillChange());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('PENDING');
  });
});

// ──────────────── Instantiation guard ────────────────

describe('OrderFSM — static-only', () => {
  it('нельзя создать экземпляр', () => {
    expect(() => new (OrderFSM as any)()).toThrow('static class');
  });
});

// ──────────────── Контракт ────────────────

describe('OrderFSM.transition() — контракт возврата', () => {
  it('возвращает Ok(undefined) для валидного перехода', () => {
    const result = OrderFSM.transition('PENDING', { type: 'ACCEPTED' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
  });

  it('возвращает Err(Error) для невалидного перехода', () => {
    const result = OrderFSM.transition('FILLED', { type: 'ACCEPTED' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(Error);
  });
});

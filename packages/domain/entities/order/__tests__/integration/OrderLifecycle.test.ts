/**
 * Интеграционные тесты для жизненного цикла Order
 *
 * @remarks
 * Тестируют end-to-end сценарии через публичный API Order entity:
 * - Полный happy path: PENDING → OPEN → PARTIALLY_FILLED → FILLED
 * - Отклонение: PENDING → REJECTED
 * - Отмена: OPEN → CANCELED
 * - Истечение: PARTIALLY_FILLED → EXPIRED
 * - Несколько fills с weighted average price
 * - Корректность вычислений после переходов
 */

import { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import {
  asOrderId,
  asFillId,
  assetIdToString,
  parseConditionId,
  parseOutcomeKey,
  KnownChainIds,
  KnownOnChainProtocols,
} from '@polymarket/ids';
import type { AssetId } from '@polymarket/ids';
import Decimal from 'decimal.js';
import { Order } from '../../src/Order';
import { OrderDeserializer } from '../../src/view/OrderDeserializer';
import { OrderViewModel } from '../../src/view/OrderViewModel';
import type { OrderJSON } from '../../src/view/OrderDeserializer';
import type { FillForOrder } from '../../src/types/OrderChange';

// ──────────────── Фикстуры ────────────────

const ASSET: AssetId = {
  type: 'OUTCOME_TOKEN',
  conditionRef: {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: parseConditionId('0x' + 'b'.repeat(64))!,
  },
  outcomeKey: parseOutcomeKey('YES')!,
};

const ORDER_ID = asOrderId('integration-order-1')!;
const FILL_IDS = [
  asFillId('fill-int-1')!,
  asFillId('fill-int-2')!,
  asFillId('fill-int-3')!,
];

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: unknown }, ctx = ''): T {
  if (!r.ok) {
    const msg = (r as any).error?.message ?? String((r as any).error);
    throw new Error(`unwrap failed${ctx ? ` (${ctx})` : ''}: ${msg}`);
  }
  return (r as { ok: true; value: T }).value;
}

function makePendingOrder() {
  return unwrap(Order.create({
    id: ORDER_ID,
    asset: ASSET,
    side: 'BUY',
    price: Price.of(new Decimal('0.60')),
    size: Quantity.of(new Decimal('100')),
    status: 'PENDING',
    timestamp: Timestamp.now(),
  }), 'makePendingOrder');
}

function makeFill(idx: number, size: number, price: number): FillForOrder {
  return {
    id: FILL_IDS[idx],
    orderId: ORDER_ID,
    asset: ASSET,
    side: 'BUY',
    size: Quantity.of(new Decimal(String(size))),
    price: Price.of(new Decimal(String(price))),
  };
}

// ──────────────── Сценарий 1: PENDING → OPEN → FILLED ────────────────

describe('Сценарий: успешное полное исполнение', () => {
  it('PENDING → OPEN → FILLED (один fill)', () => {
    const pending = makePendingOrder();
    expect(pending.status).toBe('PENDING');
    expect(pending.isPending()).toBe(true);

    // Биржа приняла
    const open = unwrap(pending.accept());
    expect(open.status).toBe('OPEN');
    expect(open.isOpen()).toBe(true);
    expect(open.fill.isEmpty()).toBe(true);

    // Полное исполнение
    const filled = unwrap(open.applyFill(makeFill(0, 100, 0.60)));
    expect(filled.status).toBe('FILLED');
    expect(filled.isFilled()).toBe(true);
    expect(filled.fill.getFilledSize().value().toNumber()).toBe(100);
    expect(filled.getRemainingSize().value().toNumber()).toBe(0);
    expect(filled.getFillPercentage().toNumber()).toBe(100);
  });

  it('исходный объект не изменился (иммутабельность)', () => {
    const pending = makePendingOrder();
    const open = unwrap(pending.accept());
    const filled = unwrap(open.applyFill(makeFill(0, 100, 0.60)));

    // Оригиналы остались прежними
    expect(pending.status).toBe('PENDING');
    expect(open.status).toBe('OPEN');
    // Только filled получил новый статус
    expect(filled.status).toBe('FILLED');
  });
});

// ──────────────── Сценарий 2: Несколько fills с VWAP ────────────────

describe('Сценарий: несколько fills с weighted average price', () => {
  it('OPEN → PARTIALLY_FILLED → PARTIALLY_FILLED → FILLED', () => {
    const order = unwrap(Order.create({
      id: ORDER_ID,
      asset: ASSET,
      side: 'BUY',
      price: Price.of(new Decimal('0.60')),
      size: Quantity.of(new Decimal('100')),
      status: 'OPEN',
      timestamp: Timestamp.now(),
    }));

    // Fill 1: 40 @ 0.55
    const after1 = unwrap(order.applyFill(makeFill(0, 40, 0.55)));
    expect(after1.status).toBe('PARTIALLY_FILLED');
    expect(after1.fill.getFilledSize().value().toNumber()).toBe(40);
    expect(after1.getRemainingSize().value().toNumber()).toBe(60);

    // Fill 2: 35 @ 0.60
    const after2 = unwrap(after1.applyFill(makeFill(1, 35, 0.60)));
    expect(after2.status).toBe('PARTIALLY_FILLED');
    expect(after2.fill.getFilledSize().value().toNumber()).toBe(75);

    // Fill 3: 25 @ 0.65 → FILLED
    const after3 = unwrap(after2.applyFill(makeFill(2, 25, 0.65)));
    expect(after3.status).toBe('FILLED');
    expect(after3.fill.getFilledSize().value().toNumber()).toBe(100);
    expect(after3.getTradeCount()).toBe(3);

    // VWAP = (40*0.55 + 35*0.60 + 25*0.65) / 100 = (22 + 21 + 16.25) / 100 = 59.25 / 100 = 0.5925
    const avgPrice = after3.fill.getAverageFillPrice()!;
    expect(avgPrice.value().toNumber()).toBeCloseTo(0.5925, 5);
  });
});

// ──────────────── Сценарий 3: PENDING → REJECTED ────────────────

describe('Сценарий: отклонение биржей', () => {
  it('PENDING → REJECTED с причиной', () => {
    const order = makePendingOrder();
    const rejected = unwrap(order.reject('Invalid price for market'));
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.reason).toBe('Invalid price for market');
    expect(rejected.isFilled()).toBe(false);
  });

  it('отклонённый ордер нельзя принять', () => {
    const order = makePendingOrder();
    const rejected = unwrap(order.reject('Bad reason'));
    expect(rejected.accept().ok).toBe(false);
    expect(rejected.cancel().ok).toBe(false);
    expect(rejected.expire().ok).toBe(false);
  });

  it('reject без причины возвращает ошибку', () => {
    const order = makePendingOrder();
    expect(order.reject('').ok).toBe(false);
  });
});

// ──────────────── Сценарий 4: Отмена ────────────────

describe('Сценарий: отмена пользователем', () => {
  it('OPEN → CANCELED', () => {
    const order = unwrap(makePendingOrder().accept());
    const canceled = unwrap(order.cancel('User request'));
    expect(canceled.status).toBe('CANCELED');
    expect(canceled.reason).toBe('User request');
  });

  it('OPEN → CANCELED без причины (дефолтная)', () => {
    const order = unwrap(makePendingOrder().accept());
    const canceled = unwrap(order.cancel());
    expect(canceled.status).toBe('CANCELED');
    expect(canceled.reason).toBe('User cancelled');
  });

  it('PARTIALLY_FILLED → CANCELED', () => {
    const open = unwrap(makePendingOrder().accept());
    const partial = unwrap(open.applyFill(makeFill(0, 30, 0.60)));
    expect(partial.status).toBe('PARTIALLY_FILLED');

    const canceled = unwrap(partial.cancel('Risk limit exceeded'));
    expect(canceled.status).toBe('CANCELED');
    // fill данные сохранились
    expect(canceled.fill.getFilledSize().value().toNumber()).toBe(30);
  });

  it('PENDING нельзя отменить', () => {
    expect(makePendingOrder().cancel().ok).toBe(false);
  });

  it('FILLED нельзя отменить', () => {
    const open = unwrap(makePendingOrder().accept());
    const filled = unwrap(open.applyFill(makeFill(0, 100, 0.60)));
    expect(filled.cancel().ok).toBe(false);
  });
});

// ──────────────── Сценарий 5: Истечение ────────────────

describe('Сценарий: истечение по времени', () => {
  it('OPEN → EXPIRED', () => {
    const order = unwrap(makePendingOrder().accept());
    const expired = unwrap(order.expire());
    expect(expired.status).toBe('EXPIRED');
  });

  it('PARTIALLY_FILLED → EXPIRED', () => {
    const open = unwrap(makePendingOrder().accept());
    const partial = unwrap(open.applyFill(makeFill(0, 50, 0.60)));
    const expired = unwrap(partial.expire());
    expect(expired.status).toBe('EXPIRED');
    // Частичный fill сохранился
    expect(expired.fill.getFilledSize().value().toNumber()).toBe(50);
  });

  it('PENDING нельзя истечь', () => {
    expect(makePendingOrder().expire().ok).toBe(false);
  });
});

// ──────────────── Сценарий 6: canAcceptFill паритет с applyFill ────────────────

describe('Сценарий: canAcceptFill паритет с applyFill', () => {
  it('canAcceptFill=true ↔ applyFill.ok=true', () => {
    const order = unwrap(makePendingOrder().accept());
    const fill = makeFill(0, 30, 0.60);

    expect(order.canAcceptFill(fill)).toBe(true);
    expect(order.applyFill(fill).ok).toBe(true);
  });

  it('canAcceptFill=false ↔ applyFill.ok=false (превышение размера)', () => {
    const order = unwrap(makePendingOrder().accept());
    const oversized = makeFill(0, 200, 0.60);

    expect(order.canAcceptFill(oversized)).toBe(false);
    expect(order.applyFill(oversized).ok).toBe(false);
  });

  it('canAcceptFill=false ↔ applyFill.ok=false (дубль fill ID)', () => {
    const order = unwrap(makePendingOrder().accept());
    const fill = makeFill(0, 30, 0.60);
    const afterFill = unwrap(order.applyFill(fill));

    // Тот же fill ID
    expect(afterFill.canAcceptFill(fill)).toBe(false);
    expect(afterFill.applyFill(fill).ok).toBe(false);
  });
});

// ──────────────── Сценарий 7: Round-trip сериализации ────────────────

describe('Сценарий: round-trip сериализации через все статусы', () => {
  const STATUSES_TO_TEST = [
    'PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED',
  ] as const;

  it.each(STATUSES_TO_TEST)('сериализация/десериализация Order в статусе %s', (status) => {
    const order = unwrap(Order.create({
      id: ORDER_ID,
      asset: ASSET,
      side: 'BUY',
      price: Price.of(new Decimal('0.60')),
      size: Quantity.of(new Decimal('100')),
      status,
      timestamp: Timestamp.now(),
      reason: status === 'REJECTED' ? 'Invalid price' : undefined,
    }));

    const json = order.toJSON() as unknown as OrderJSON;
    const restored = unwrap(OrderDeserializer.fromJSON(json), `fromJSON(${status})`);

    expect(restored.id).toBe(order.id);
    expect(restored.status).toBe(order.status);
    expect(restored.side).toBe(order.side);
    expect(restored.price.value().toNumber()).toBe(order.price.value().toNumber());
    expect(restored.size.value().toNumber()).toBe(order.size.value().toNumber());
    expect(assetIdToString(restored.asset)).toBe(assetIdToString(order.asset));
  });

  it('сериализация после серии fills и восстановление', () => {
    const open = unwrap(Order.create({
      id: ORDER_ID,
      asset: ASSET,
      side: 'BUY',
      price: Price.of(new Decimal('0.60')),
      size: Quantity.of(new Decimal('100')),
      status: 'OPEN',
      timestamp: Timestamp.now(),
    }));

    const partial = unwrap(open.applyFill(makeFill(0, 60, 0.58)));
    const viewJson = OrderViewModel.toJSON(partial) as unknown as OrderJSON;
    const restored = unwrap(OrderDeserializer.fromJSON(viewJson), 'fromJSON partial');

    expect(restored.status).toBe('PARTIALLY_FILLED');
    expect(restored.fill.getFilledSize().value().toNumber()).toBe(60);
    expect(restored.fill.getAverageFillPrice()?.value().toNumber()).toBe(0.58);
    expect(restored.fill.getFillIds()).toEqual([FILL_IDS[0]]);
  });
});

// ──────────────── Сценарий 8: Вычисления ────────────────

describe('Сценарий: вычисления в разных состояниях', () => {
  it('getNotional = price * size (до fills)', () => {
    const order = unwrap(Order.create({
      id: ORDER_ID,
      asset: ASSET,
      side: 'SELL',
      price: Price.of(new Decimal('0.75')),
      size: Quantity.of(new Decimal('200')),
      status: 'OPEN',
      timestamp: Timestamp.now(),
    }));
    expect(order.getNotional().toNumber()).toBe(150); // 0.75 * 200
  });

  it('getRemainingSize корректен после нескольких fills', () => {
    const open = unwrap(Order.create({
      id: ORDER_ID,
      asset: ASSET,
      side: 'BUY',
      price: Price.of(new Decimal('0.60')),
      size: Quantity.of(new Decimal('100')),
      status: 'OPEN',
      timestamp: Timestamp.now(),
    }));

    const after1 = unwrap(open.applyFill(makeFill(0, 25, 0.60)));
    expect(after1.getRemainingSize().value().toNumber()).toBe(75);

    const after2 = unwrap(after1.applyFill(makeFill(1, 40, 0.60)));
    expect(after2.getRemainingSize().value().toNumber()).toBe(35);
  });

  it('getFillPercentage = 0% для нового ордера, 100% для FILLED', () => {
    const openOrder = unwrap(Order.create({
      id: ORDER_ID,
      asset: ASSET,
      side: 'BUY',
      price: Price.of(new Decimal('0.60')),
      size: Quantity.of(new Decimal('100')),
      status: 'OPEN',
      timestamp: Timestamp.now(),
    }));
    expect(openOrder.getFillPercentage().toNumber()).toBe(0);

    const filled = unwrap(openOrder.applyFill(makeFill(0, 100, 0.60)));
    expect(filled.getFillPercentage().toNumber()).toBe(100);
  });
});

/**
 * Интеграционные тесты для жизненного цикла Order
 *
 * @remarks
 * End-to-end сценарии через публичный API Order aggregate:
 * - Полный happy path: PENDING → OPEN → PARTIALLY_FILLED → FILLED
 * - Отклонение: PENDING → REJECTED
 * - Отмена: OPEN → CANCELED
 * - Истечение: PARTIALLY_FILLED → EXPIRED
 * - Несколько fills с weighted average price (VWAP)
 * - Корректность вычислений после переходов
 * - Round-trip сериализации: toSnapshot → fromSnapshot
 * - Replay через fromEvents
 */

import { Price, Quantity } from '@polymarket/value-objects';
import { Timestamp } from '@polymarket/timestamp';
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
import type { OrderSnapshot } from '../../src/OrderState';
import type { FillData } from '@polymarket/fill';
import { replay, nextTestMetadata } from '../helpers';

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
    timestamp: Timestamp.now(),
  }), 'makePendingOrder');
}

function makeFill(idx: number, size: number, price: number): FillData {
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
    expect(open.filledSize.isZero()).toBe(true);

    // Полное исполнение
    const filled = unwrap(open.applyFill(makeFill(0, 100, 0.60)));
    expect(filled.status).toBe('FILLED');
    expect(filled.isFilled()).toBe(true);
    expect(filled.filledSize.value().toNumber()).toBe(100);
    expect(filled.remainingSize.value().toNumber()).toBe(0);
    expect(filled.fillPercentage.toNumber()).toBe(100);
  });

  it('исходный объект не изменился (иммутабельность)', () => {
    const pending = makePendingOrder();
    const open = unwrap(pending.accept());
    const filled = unwrap(open.applyFill(makeFill(0, 100, 0.60)));

    expect(pending.status).toBe('PENDING');
    expect(open.status).toBe('OPEN');
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
      timestamp: Timestamp.now(),
    }));
    const open = unwrap(order.accept());

    // Fill 1: 40 @ 0.55
    const after1 = unwrap(open.applyFill(makeFill(0, 40, 0.55)));
    expect(after1.status).toBe('PARTIALLY_FILLED');
    expect(after1.filledSize.value().toNumber()).toBe(40);
    expect(after1.remainingSize.value().toNumber()).toBe(60);

    // Fill 2: 35 @ 0.60
    const after2 = unwrap(after1.applyFill(makeFill(1, 35, 0.60)));
    expect(after2.status).toBe('PARTIALLY_FILLED');
    expect(after2.filledSize.value().toNumber()).toBe(75);

    // Fill 3: 25 @ 0.65 → FILLED
    const after3 = unwrap(after2.applyFill(makeFill(2, 25, 0.65)));
    expect(after3.status).toBe('FILLED');
    expect(after3.filledSize.value().toNumber()).toBe(100);
    expect(after3.tradeCount).toBe(3);

    // VWAP = (40*0.55 + 35*0.60 + 25*0.65) / 100 = (22 + 21 + 16.25) / 100 = 59.25 / 100 = 0.5925
    const avgPrice = after3.averagePrice!;
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

  it('отклонённый ордер нельзя принять/отменить/истечь', () => {
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

  it('PARTIALLY_FILLED → CANCELED, fill данные сохранились', () => {
    const open = unwrap(makePendingOrder().accept());
    const partial = unwrap(open.applyFill(makeFill(0, 30, 0.60)));
    expect(partial.status).toBe('PARTIALLY_FILLED');

    const canceled = unwrap(partial.cancel('Risk limit exceeded'));
    expect(canceled.status).toBe('CANCELED');
    expect(canceled.filledSize.value().toNumber()).toBe(30);
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

  it('PARTIALLY_FILLED → EXPIRED, fill данные сохранились', () => {
    const open = unwrap(makePendingOrder().accept());
    const partial = unwrap(open.applyFill(makeFill(0, 50, 0.60)));
    const expired = unwrap(partial.expire());
    expect(expired.status).toBe('EXPIRED');
    expect(expired.filledSize.value().toNumber()).toBe(50);
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

    expect(afterFill.canAcceptFill(fill)).toBe(false);
    expect(afterFill.applyFill(fill).ok).toBe(false);
  });
});

// ──────────────── Сценарий 7: Round-trip сериализации ────────────────

describe('Сценарий: round-trip сериализации через все статусы', () => {
  const STATUSES_TO_TEST = [
    'PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED',
  ] as const;

  it.each(STATUSES_TO_TEST)('toSnapshot → fromSnapshot для статуса %s', (status) => {
    const isFilled = status === 'FILLED';
    const isPartial = status === 'PARTIALLY_FILLED';
    const snap = {
      id: ORDER_ID as string,
      asset: assetIdToString(ASSET),
      side: 'BUY' as const,
      price: 0.60,
      size: 100,
      status,
      timestamp: new Date().toISOString(),
      filledSize: isFilled ? 100 : (isPartial ? 50 : 0),
      averagePrice: (isFilled || isPartial) ? 0.60 : undefined,
      fillIds: (isFilled || isPartial) ? [FILL_IDS[0] as string] : [] as string[],
      reason: status === 'REJECTED' ? 'Invalid price' : undefined,
    };

    const order = unwrap(OrderDeserializer.fromSnapshot(snap), `fromSnapshot(${status})`);
    const restored = unwrap(OrderDeserializer.fromSnapshot(order.toSnapshot()), `roundtrip(${status})`);

    expect(restored.id).toBe(order.id);
    expect(restored.status).toBe(order.status);
    expect(restored.side).toBe(order.side);
    expect(restored.price.value().toNumber()).toBe(order.price.value().toNumber());
    expect(restored.size.value().toNumber()).toBe(order.size.value().toNumber());
    expect(assetIdToString(restored.asset)).toBe(assetIdToString(order.asset));
  });

  it('сериализация через OrderViewModel → OrderDeserializer (round-trip)', () => {
    const open = unwrap(Order.create({
      id: ORDER_ID,
      asset: ASSET,
      side: 'BUY',
      price: Price.of(new Decimal('0.60')),
      size: Quantity.of(new Decimal('100')),
      timestamp: Timestamp.now(),
    }));
    const openOrder = unwrap(open.accept());
    const partial = unwrap(openOrder.applyFill(makeFill(0, 60, 0.58)));

    // Сериализуем через OrderViewModel (включает доп. поля: notional, remainingSize, fillPercentage)
    const viewJson = OrderViewModel.toJSON(partial);

    // Десериализуем из viewJson — fromSnapshot игнорирует лишние поля
    const restored = unwrap(
      OrderDeserializer.fromSnapshot(viewJson as unknown as OrderSnapshot),
      'fromSnapshot via viewJson'
    );

    expect(restored.status).toBe('PARTIALLY_FILLED');
    expect(restored.filledSize.value().toNumber()).toBe(60);
    expect(restored.averagePrice?.value().toNumber()).toBe(0.58);
    expect(restored.fillIds).toEqual([FILL_IDS[0]]);

    // Дополнительные вычисляемые поля присутствуют в viewJson (не теряются при сериализации)
    expect(viewJson.notional).toBe(60); // 0.60 * 100
    expect(viewJson.remainingSize).toBe(40); // 100 - 60
    expect(viewJson.fillPercentage).toBe(60); // 60 / 100 * 100
  });
});

// ──────────────── Сценарий 8: Вычисления ────────────────

describe('Сценарий: вычисления в разных состояниях', () => {
  it('notional = price * size (до fills)', () => {
    const order = unwrap(Order.create({
      id: ORDER_ID,
      asset: ASSET,
      side: 'SELL',
      price: Price.of(new Decimal('0.75')),
      size: Quantity.of(new Decimal('200')),
      timestamp: Timestamp.now(),
    }));
    const open = unwrap(order.accept());
    expect(open.notional.toNumber()).toBe(150); // 0.75 * 200
  });

  it('remainingSize корректен после нескольких fills', () => {
    const open = unwrap(unwrap(Order.create({
      id: ORDER_ID,
      asset: ASSET,
      side: 'BUY',
      price: Price.of(new Decimal('0.60')),
      size: Quantity.of(new Decimal('100')),
      timestamp: Timestamp.now(),
    })).accept());

    const after1 = unwrap(open.applyFill(makeFill(0, 25, 0.60)));
    expect(after1.remainingSize.value().toNumber()).toBe(75);

    const after2 = unwrap(after1.applyFill(makeFill(1, 40, 0.60)));
    expect(after2.remainingSize.value().toNumber()).toBe(35);
  });

  it('fillPercentage = 0% для нового ордера, 100% для FILLED', () => {
    const open = unwrap(unwrap(Order.create({
      id: ORDER_ID,
      asset: ASSET,
      side: 'BUY',
      price: Price.of(new Decimal('0.60')),
      size: Quantity.of(new Decimal('100')),
      timestamp: Timestamp.now(),
    })).accept());

    expect(open.fillPercentage.toNumber()).toBe(0);

    const filled = unwrap(open.applyFill(makeFill(0, 100, 0.60)));
    expect(filled.fillPercentage.toNumber()).toBe(100);
  });
});

// ──────────────── Сценарий 9: fromEvents replay ────────────────

describe('Сценарий: fromEvents replay', () => {
  it('воспроизводит полный жизненный цикл из событий', () => {
    const ts = Timestamp.now();

    const fillData: FillData = {
      id: FILL_IDS[0],
      orderId: ORDER_ID,
      asset: ASSET,
      side: 'BUY',
      size: Quantity.of(new Decimal('100')),
      price: Price.of(new Decimal('0.60')),
    };

    const order = replay([
      {
        type: 'ORDER_CREATED',
        payload: {
          orderId: ORDER_ID,
          asset: ASSET,
          side: 'BUY',
          price: Price.of(new Decimal('0.60')),
          size: Quantity.of(new Decimal('100')),
          timestamp: ts,
        },
        metadata: nextTestMetadata(),
      },
      {
        type: 'ORDER_ACCEPTED',
        payload: {
          orderId: ORDER_ID
        },
        metadata: nextTestMetadata(),
      },
      {
        type: 'ORDER_FILLED',
        payload: {
          orderId: ORDER_ID, fill: fillData, averagePrice: fillData.price
        },
        metadata: nextTestMetadata(),
      },
    ]);

    expect(order.status).toBe('FILLED');
    expect(order.filledSize.value().toNumber()).toBe(100);
    expect(order.tradeCount).toBe(1);
  });

  it('воспроизводит отклонение из событий', () => {
    const ts = Timestamp.now();

    const order = replay([
      {
        type: 'ORDER_CREATED',
        payload: {
          orderId: ORDER_ID,
          asset: ASSET,
          side: 'BUY',
          price: Price.of(new Decimal('0.60')),
          size: Quantity.of(new Decimal('100')),
          timestamp: ts,
        },
        metadata: nextTestMetadata(),
      },
      {
        type: 'ORDER_REJECTED',
        payload: {
          orderId: ORDER_ID, reason: 'Bad price'
        },
        metadata: nextTestMetadata(),
      },
    ]);

    expect(order.status).toBe('REJECTED');
    expect(order.reason).toBe('Bad price');
  });
});

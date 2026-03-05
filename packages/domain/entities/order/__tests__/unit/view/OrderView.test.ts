/**
 * Тесты для OrderViewModel и OrderDeserializer
 *
 * @remarks
 * Покрывает:
 * - Сериализацию через OrderViewModel (toJSON, toReadable, toSummary)
 * - Десериализацию через OrderDeserializer (fromSnapshot, fromSnapshotArray, fromSnapshotArrayPartial)
 * - Round-trip: Order → toSnapshot → fromSnapshot → Order
 */

import { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import {
  asOrderId,
  asFillId,
  parseConditionId,
  parseOutcomeKey,
  KnownChainIds,
  KnownOnChainProtocols,
  assetIdToString,
} from '@polymarket/ids';
import type { AssetId } from '@polymarket/ids';
import Decimal from 'decimal.js';
import { Order } from '../../../src/Order';
import { OrderViewModel } from '../../../src/view/OrderViewModel';
import { OrderDeserializer } from '../../../src/view/OrderDeserializer';
import type { OrderSnapshot } from '../../../src/OrderState';
import type { FillData } from '../../../src/OrderState';

// Вспомогательная функция
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, ctx = ''): T {
  if (!result.ok) {
    const err = (result as { ok: false; error: unknown }).error;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Expected Ok result${ctx ? ` (${ctx})` : ''}: ${msg}`);
  }
  return (result as { ok: true; value: T }).value;
}

// Тестовый AssetId
const TEST_ASSET: AssetId = {
  type: 'OUTCOME_TOKEN',
  conditionRef: {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: parseConditionId('0x' + 'a'.repeat(64))!,
  },
  outcomeKey: parseOutcomeKey('YES')!,
};

const ORDER_ID = asOrderId('order-abc')!;
const FILL_ID_1 = asFillId('fill-1')!;

/** Создаёт OPEN Order через create() + accept() */
function createOpenOrder(overrides?: Partial<Parameters<typeof Order.create>[0]>) {
  const base = unwrap(Order.create({
    id: ORDER_ID,
    asset: TEST_ASSET,
    side: 'BUY' as const,
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('100')),
    timestamp: Timestamp.now(),
    ...overrides,
  }), 'Order.create');
  return unwrap(base.accept(), 'accept');
}

/** Создаёт базовый OrderSnapshot */
function makeOrderSnap(overrides?: Partial<OrderSnapshot>): OrderSnapshot {
  return {
    id: 'order-abc',
    asset: assetIdToString(TEST_ASSET),
    side: 'BUY',
    price: 0.65,
    size: 100,
    status: 'OPEN',
    timestamp: '2024-01-15T12:00:00.000Z',
    filledSize: 0,
    fillIds: [],
    ...overrides,
  };
}

const FILL_1: FillData = {
  id: FILL_ID_1,
  orderId: ORDER_ID,
  asset: TEST_ASSET,
  side: 'BUY',
  size: Quantity.of(new Decimal('30')),
  price: Price.of(new Decimal('0.65')),
};

// ==================== OrderViewModel ====================

describe('OrderViewModel', () => {
  describe('toJSON()', () => {
    it('должен сериализовать Order в plain object с обязательными полями', () => {
      const order = createOpenOrder();
      const json = OrderViewModel.toJSON(order);

      expect(json.id).toBe(ORDER_ID);
      expect(json.side).toBe('BUY');
      expect(json.price).toBe(0.65);
      expect(json.size).toBe(100);
      expect(json.status).toBe('OPEN');
      expect(typeof json.timestamp).toBe('string');
      expect(json.asset).toBe(assetIdToString(TEST_ASSET));
    });

    it('должен включать вычисляемые поля (notional, remainingSize, fillPercentage)', () => {
      const order = createOpenOrder();
      const json = OrderViewModel.toJSON(order);

      expect(json.notional).toBe(65); // 0.65 * 100
      expect(json.remainingSize).toBe(100);
      expect(json.fillPercentage).toBe(0);
    });

    it('должен включать fill-данные после частичного исполнения', () => {
      const order = createOpenOrder();
      const filled = unwrap(order.applyFill(FILL_1), 'applyFill');
      const json = OrderViewModel.toJSON(filled);

      expect(json.filledSize).toBe(30);
      expect(json.averagePrice).toBe(0.65);
      expect(json.remainingSize).toBe(70);
      expect(json.fillPercentage).toBe(30);
    });

    it('должен сериализовать strategyId когда задан', () => {
      const order = createOpenOrder({ strategyId: 'strat-1' });
      const json = OrderViewModel.toJSON(order);
      expect(json.strategyId).toBe('strat-1');
    });
  });

  describe('toReadable()', () => {
    it('должен возвращать строку с ключевыми полями', () => {
      const order = createOpenOrder();
      const str = OrderViewModel.toReadable(order);

      expect(str).toContain('order-abc');
      expect(str).toContain('BUY');
      expect(str).toContain('100');
      expect(str).toContain('0.65');
      expect(str).toContain('OPEN');
    });

    it('должен показывать "unfilled" для пустого fill', () => {
      const order = createOpenOrder();
      const str = OrderViewModel.toReadable(order);
      expect(str).toContain('unfilled');
    });

    it('должен показывать процент заполнения для частичного fill', () => {
      const order = createOpenOrder();
      const filled = unwrap(order.applyFill(FILL_1));
      const str = OrderViewModel.toReadable(filled);
      expect(str).toContain('30.0% filled');
    });
  });

  describe('toSummary()', () => {
    it('должен возвращать summary с числовыми полями', () => {
      const order = createOpenOrder();
      const summary = OrderViewModel.toSummary(order);

      expect(summary.id).toBe(ORDER_ID);
      expect(summary.status).toBe('OPEN');
      expect(summary.side).toBe('BUY');
      expect(summary.price).toBe(0.65);
      expect(summary.size).toBe(100);
      expect(summary.filled).toBe(0);
      expect(summary.remaining).toBe(100);
      expect(summary.fillPercentage).toBe(0);
    });
  });
});

// ==================== OrderDeserializer ====================

describe('OrderDeserializer', () => {
  describe('fromSnapshot()', () => {
    it('должен десериализовать валидный снэпшот в Order', () => {
      const result = OrderDeserializer.fromSnapshot(makeOrderSnap());

      expect(result.ok).toBe(true);
      if (result.ok) {
        const order = result.value;
        expect(order.id).toBe('order-abc');
        expect(order.side).toBe('BUY');
        expect(order.price.value().toNumber()).toBe(0.65);
        expect(order.size.value().toNumber()).toBe(100);
        expect(order.status).toBe('OPEN');
      }
    });

    it('должен десериализовать снэпшот с fill', () => {
      const snap = makeOrderSnap({
        status: 'PARTIALLY_FILLED',
        filledSize: 30,
        averagePrice: 0.65,
        fillIds: [FILL_ID_1 as string],
      });

      const result = OrderDeserializer.fromSnapshot(snap);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.filledSize.value().toNumber()).toBe(30);
        expect(result.value.averagePrice?.value().toNumber()).toBe(0.65);
        expect(result.value.fillIds).toContain(FILL_ID_1);
      }
    });

    it('должен вернуть Err для невалидного id', () => {
      const result = OrderDeserializer.fromSnapshot(makeOrderSnap({ id: '' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('order ID');
      }
    });

    it('должен вернуть Err для невалидного side', () => {
      const result = OrderDeserializer.fromSnapshot(makeOrderSnap({ side: 'LONG' as 'BUY' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('side');
      }
    });

    it('должен вернуть Err для невалидного timestamp', () => {
      const result = OrderDeserializer.fromSnapshot(makeOrderSnap({ timestamp: 'not-a-date' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('timestamp');
      }
    });

    it('должен вернуть Err для невалидного fill ID', () => {
      const result = OrderDeserializer.fromSnapshot(makeOrderSnap({
        status: 'PARTIALLY_FILLED',
        filledSize: 30,
        averagePrice: 0.65,
        fillIds: ['', 'valid-fill-1'],
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('fill ID');
      }
    });

    it('должен вернуть Err для невалидного asset', () => {
      const result = OrderDeserializer.fromSnapshot(makeOrderSnap({ asset: 'INVALID:FORMAT' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('asset');
      }
    });

    it('должен вернуть Err для null снэпшота', () => {
      const result = OrderDeserializer.fromSnapshot(null as unknown as OrderSnapshot);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('object');
    });

    it('должен вернуть Err для невалидного status', () => {
      const result = OrderDeserializer.fromSnapshot(makeOrderSnap({ status: 'UNKNOWN' as 'OPEN' }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('status');
    });

    it('должен вернуть Err при несогласованном состоянии (FILLED + filledSize ≠ size)', () => {
      // FILLED заявка с filledSize 0 — нарушение инварианта rehydrate()
      const result = OrderDeserializer.fromSnapshot(makeOrderSnap({
        status: 'FILLED',
        filledSize: 0,
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('filledSize');
    });

    it('должен вернуть Err если VO конструктор бросает (price = -1)', () => {
      // Price.of(-1) бросает — catch блок преобразует в ValidationError
      const result = OrderDeserializer.fromSnapshot(makeOrderSnap({ price: -1 }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('Failed to restore');
    });

    it('должен вернуть Err если fillIds равен null', () => {
      // null вместо [] бросает TypeError в for...of — catch блок обработает
      const result = OrderDeserializer.fromSnapshot(makeOrderSnap({ fillIds: null as unknown as string[] }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('Failed to restore');
    });

    it('catch-блок обрабатывает non-Error исключения (ветка String(e))', () => {
      // Геттер бросает строку — не Error-инстанс — покрывает ветку String(e)
      const snap = makeOrderSnap();
      Object.defineProperty(snap, 'fillIds', {
        get() { throw 'raw string error'; },
        configurable: true,
      });
      const result = OrderDeserializer.fromSnapshot(snap);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Failed to restore');
        expect(result.error.message).toContain('raw string error');
      }
    });
  });

  describe('fromJSON() (deprecated alias)', () => {
    it('должен работать как fromSnapshot', () => {
      const result = OrderDeserializer.fromJSON(makeOrderSnap());
      expect(result.ok).toBe(true);
    });
  });

  describe('fromSnapshotArray()', () => {
    it('должен десериализовать массив валидных снэпшотов', () => {
      const snaps = [
        makeOrderSnap({ id: 'order-1' }),
        makeOrderSnap({ id: 'order-2' }),
        makeOrderSnap({ id: 'order-3' }),
      ];

      const result = OrderDeserializer.fromSnapshotArray(snaps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
        expect(result.value[0].id).toBe('order-1');
        expect(result.value[1].id).toBe('order-2');
        expect(result.value[2].id).toBe('order-3');
      }
    });

    it('должен вернуть Err при первом невалидном элементе', () => {
      const snaps = [
        makeOrderSnap({ id: 'order-1' }),
        makeOrderSnap({ id: '' }), // невалидный
        makeOrderSnap({ id: 'order-3' }),
      ];

      const result = OrderDeserializer.fromSnapshotArray(snaps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('index 1');
      }
    });

    it('должен вернуть Err для не-массива', () => {
      const result = OrderDeserializer.fromSnapshotArray('not an array' as unknown as OrderSnapshot[]);
      expect(result.ok).toBe(false);
    });

    it('должен вернуть Ok([]) для пустого массива', () => {
      const result = OrderDeserializer.fromSnapshotArray([]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });

  describe('fromJSONArray() (deprecated alias)', () => {
    it('должен работать как fromSnapshotArray', () => {
      const result = OrderDeserializer.fromJSONArray([makeOrderSnap({ id: 'order-1' })]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
      }
    });
  });

  describe('fromSnapshotArrayPartial()', () => {
    it('должен пропускать невалидные элементы и возвращать валидные', () => {
      const snaps = [
        makeOrderSnap({ id: 'order-1' }),
        makeOrderSnap({ id: '' }), // невалидный — пропускаем
        makeOrderSnap({ id: 'order-3' }),
      ];

      const orders = OrderDeserializer.fromSnapshotArrayPartial(snaps);

      expect(orders.length).toBe(2);
      expect(orders[0].id).toBe('order-1');
      expect(orders[1].id).toBe('order-3');
    });

    it('должен вернуть [] для не-массива', () => {
      const orders = OrderDeserializer.fromSnapshotArrayPartial('not an array' as unknown as OrderSnapshot[]);
      expect(orders).toEqual([]);
    });

    it('должен вернуть [] для пустого массива', () => {
      const orders = OrderDeserializer.fromSnapshotArrayPartial([]);
      expect(orders).toEqual([]);
    });
  });
});

// ==================== Round-trip ====================

describe('Round-trip: Order → toSnapshot → fromSnapshot', () => {
  it('должен восстановить Order из Order.toSnapshot()', () => {
    const original = createOpenOrder();
    const snap = original.toSnapshot();
    const result = OrderDeserializer.fromSnapshot(snap);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const restored = result.value;
      expect(restored.id).toBe(original.id);
      expect(restored.side).toBe(original.side);
      expect(restored.price.value().toNumber()).toBe(original.price.value().toNumber());
      expect(restored.size.value().toNumber()).toBe(original.size.value().toNumber());
      expect(restored.status).toBe(original.status);
    }
  });

  it('должен восстановить Order с fill из Order.toSnapshot()', () => {
    const order = createOpenOrder();
    const withFill = unwrap(order.applyFill({
      id: FILL_ID_1,
      orderId: ORDER_ID,
      asset: TEST_ASSET,
      side: 'BUY',
      size: Quantity.of(new Decimal('50')),
      price: Price.of(new Decimal('0.65')),
    }), 'applyFill');

    const snap = withFill.toSnapshot();
    const result = OrderDeserializer.fromSnapshot(snap);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const restored = result.value;
      expect(restored.status).toBe('PARTIALLY_FILLED');
      expect(restored.filledSize.value().toNumber()).toBe(50);
      expect(restored.averagePrice?.value().toNumber()).toBe(0.65);
    }
  });

  it('должен восстановить Order через OrderViewModel.toJSON()', () => {
    const original = createOpenOrder({ strategyId: 'strategy-42' });
    // OrderViewModel.toJSON включает дополнительные поля (notional, remainingSize, fillPercentage)
    // fromSnapshot игнорирует лишние поля — round-trip через viewJson должен работать
    const snap = OrderViewModel.toJSON(original) as unknown as OrderSnapshot;
    const result = OrderDeserializer.fromSnapshot(snap);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const restored = result.value;
      expect(restored.id).toBe(original.id);
      expect(restored.strategyId).toBe('strategy-42');
    }
  });
});

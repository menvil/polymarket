/**
 * Тесты для OrderViewModel и OrderDeserializer
 *
 * @remarks
 * Покрывает:
 * - Сериализацию через OrderViewModel (toJSON, toReadable, toSummary)
 * - Десериализацию через OrderDeserializer (fromJSON, fromJSONArray, fromJSONPartial)
 * - Round-trip: Order → toJSON → fromJSON → Order
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
import type { OrderJSON } from '../../../src/view/OrderDeserializer';
// Вспомогательная функция для извлечения значения из Result в тестах
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, ctx = ''): T {
  if (!result.ok) {
    const err = (result as { ok: false; error: unknown }).error;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Expected Ok result in test setup${ctx ? `: ${ctx}` : ''}: ${msg}`);
  }
  return (result as { ok: true; value: T }).value;
}

// Тестовый AssetId (OUTCOME_TOKEN для Polymarket Polygon)
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

/** Создаёт валидный Order в статусе OPEN */
function createOpenOrder(overrides?: Partial<Parameters<typeof Order.create>[0]>) {
  return unwrap(Order.create({
    id: ORDER_ID,
    asset: TEST_ASSET,
    side: 'BUY' as const,
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('100')),
    status: 'OPEN' as const,
    timestamp: Timestamp.now(),
    ...overrides,
  }), 'createOpenOrder');
}

/** Создаёт минимально валидный OrderJSON */
function makeOrderJSON(overrides?: Partial<OrderJSON>): OrderJSON {
  return {
    id: 'order-abc',
    // asset сериализуется как строка через assetIdToString
    asset: assetIdToString(TEST_ASSET),
    side: 'BUY',
    price: 0.65,
    size: 100,
    status: 'OPEN',
    timestamp: '2024-01-15T12:00:00.000Z',
    ...overrides,
  };
}

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
      expect(json.remainingSize).toBe(100); // нет fills
      expect(json.fillPercentage).toBe(0);
    });

    it('должен включать fill-данные после частичного исполнения', () => {
      const order = createOpenOrder();
      const filled = unwrap(order.applyFill({
        id: FILL_ID_1,
        orderId: ORDER_ID,
        asset: TEST_ASSET,
        side: 'BUY',
        size: Quantity.of(new Decimal('30')),
        price: Price.of(new Decimal('0.65')),
      }), 'applyFill');

      const json = OrderViewModel.toJSON(filled);

      expect((json.fill as Record<string, unknown>).filledSize).toBe(30);
      expect((json.fill as Record<string, unknown>).averageFillPrice).toBe(0.65);
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
      const filled = unwrap(order.applyFill({
        id: FILL_ID_1,
        orderId: ORDER_ID,
        asset: TEST_ASSET,
        side: 'BUY',
        size: Quantity.of(new Decimal('30')),
        price: Price.of(new Decimal('0.65')),
      }));

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
  describe('fromJSON()', () => {
    it('должен десериализовать валидный OrderJSON в Order', () => {
      const json = makeOrderJSON();
      const result = OrderDeserializer.fromJSON(json);

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

    it('должен десериализовать OrderJSON с fill', () => {
      const json = makeOrderJSON({
        status: 'PARTIALLY_FILLED',
        fill: {
          filledSize: 30,
          averageFillPrice: 0.65,
          fillIds: [FILL_ID_1],
        },
      });

      const result = OrderDeserializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.fill.getFilledSize().value().toNumber()).toBe(30);
        expect(result.value.fill.getAverageFillPrice()?.value().toNumber()).toBe(0.65);
        expect(result.value.fill.getFillIds()).toEqual([FILL_ID_1]);
      }
    });

    it('должен вернуть Err для невалидного id', () => {
      const result = OrderDeserializer.fromJSON(makeOrderJSON({ id: '' }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('order ID');
      }
    });

    it('должен вернуть Err для невалидного side', () => {
      const result = OrderDeserializer.fromJSON(makeOrderJSON({ side: 'LONG' as 'BUY' }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('side');
      }
    });

    it('должен вернуть Err для невалидного timestamp', () => {
      const result = OrderDeserializer.fromJSON(makeOrderJSON({ timestamp: 'not-a-date' }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('timestamp');
      }
    });

    it('должен вернуть Err для невалидного fill (filledSize > 0 без averageFillPrice)', () => {
      const result = OrderDeserializer.fromJSON(makeOrderJSON({
        status: 'PARTIALLY_FILLED',
        fill: {
          filledSize: 30,
          averageFillPrice: undefined,
          fillIds: [],
        },
      }));

      expect(result.ok).toBe(false);
    });

    it('должен вернуть Err для невалидного fill ID', () => {
      const result = OrderDeserializer.fromJSON(makeOrderJSON({
        status: 'PARTIALLY_FILLED',
        fill: {
          filledSize: 30,
          averageFillPrice: 0.65,
          fillIds: ['', 'valid-fill-1'],
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('fill ID');
      }
    });

    it('должен вернуть Err для невалидного asset', () => {
      const result = OrderDeserializer.fromJSON(makeOrderJSON({ asset: 'INVALID:FORMAT' }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('asset');
      }
    });
  });

  describe('fromJSONArray()', () => {
    it('должен десериализовать массив валидных OrderJSON', () => {
      const jsonArray = [
        makeOrderJSON({ id: 'order-1' }),
        makeOrderJSON({ id: 'order-2' }),
        makeOrderJSON({ id: 'order-3' }),
      ];

      const result = OrderDeserializer.fromJSONArray(jsonArray);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
        expect(result.value[0].id).toBe('order-1');
        expect(result.value[1].id).toBe('order-2');
        expect(result.value[2].id).toBe('order-3');
      }
    });

    it('должен вернуть Err при первом невалидном элементе', () => {
      const jsonArray = [
        makeOrderJSON({ id: 'order-1' }),
        makeOrderJSON({ id: '' }), // невалидный
        makeOrderJSON({ id: 'order-3' }),
      ];

      const result = OrderDeserializer.fromJSONArray(jsonArray);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('index 1');
      }
    });

    it('должен вернуть Err для не-массива', () => {
      const result = OrderDeserializer.fromJSONArray('not an array' as unknown as OrderJSON[]);

      expect(result.ok).toBe(false);
    });

    it('должен вернуть Ok([]) для пустого массива', () => {
      const result = OrderDeserializer.fromJSONArray([]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });

  describe('fromJSONPartial()', () => {
    it('должен пропускать невалидные элементы и возвращать валидные', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const jsonArray = [
        makeOrderJSON({ id: 'order-1' }),
        makeOrderJSON({ id: '' }), // невалидный — пропускаем
        makeOrderJSON({ id: 'order-3' }),
      ];

      const orders = OrderDeserializer.fromJSONPartial(jsonArray);

      expect(orders.length).toBe(2);
      expect(orders[0].id).toBe('order-1');
      expect(orders[1].id).toBe('order-3');
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });

    it('должен вернуть [] для не-массива', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const orders = OrderDeserializer.fromJSONPartial('not an array' as unknown as OrderJSON[]);

      expect(orders).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });

    it('должен вернуть [] для пустого массива', () => {
      const orders = OrderDeserializer.fromJSONPartial([]);
      expect(orders).toEqual([]);
    });
  });
});

// ==================== Round-trip ====================

describe('Round-trip: Order → toJSON → fromJSON', () => {
  it('должен восстановить Order из Order.toJSON()', () => {
    const original = createOpenOrder();
    const json = original.toJSON() as unknown as OrderJSON;

    const result = OrderDeserializer.fromJSON(json);

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

  it('должен восстановить Order с fill из Order.toJSON()', () => {
    const order = createOpenOrder();
    const withFill = unwrap(order.applyFill({
      id: FILL_ID_1,
      orderId: ORDER_ID,
      asset: TEST_ASSET,
      side: 'BUY',
      size: Quantity.of(new Decimal('50')),
      price: Price.of(new Decimal('0.65')),
    }), 'applyFill');

    const json = withFill.toJSON() as unknown as OrderJSON;
    const result = OrderDeserializer.fromJSON(json);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const restored = result.value;
      expect(restored.status).toBe('PARTIALLY_FILLED');
      expect(restored.fill.getFilledSize().value().toNumber()).toBe(50);
      expect(restored.fill.getAverageFillPrice()?.value().toNumber()).toBe(0.65);
    }
  });

  it('должен восстановить Order через OrderViewModel.toJSON()', () => {
    const original = createOpenOrder({ strategyId: 'strategy-42' });
    const viewJson = OrderViewModel.toJSON(original) as unknown as OrderJSON;

    const result = OrderDeserializer.fromJSON(viewJson);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const restored = result.value;
      expect(restored.id).toBe(original.id);
      expect(restored.strategyId).toBe('strategy-42');
    }
  });
});

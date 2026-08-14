/**
 * Тесты для Order aggregate
 */

import { Price, Quantity } from '@polymarket/value-objects';
import { Timestamp } from '@polymarket/timestamp';
import type { AssetId, OrderId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
import {
  asOrderId,
  asFillId,
  parseConditionId,
  parseOutcomeKey,
  KnownChainIds,
  KnownOnChainProtocols,
} from '@polymarket/ids';
import Decimal from 'decimal.js';
import { Order } from '../../src/Order';
import { OrderDeserializer } from '../../src/view/OrderDeserializer';
import type { FillState, OrderState } from '../../src/OrderState';
import type { FillData } from '@polymarket/fill';
import { replay, nextTestMetadata } from '../helpers';

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

// Branded IDs для тестов
const ORDER_ID = asOrderId('order-123')!;
const FILL_ID_1 = asFillId('fill-1')!;
const FILL_ID_2 = asFillId('fill-2')!;
const FILL_ID_3 = asFillId('fill-3')!;

// Helper для создания валидного PENDING Order
function createValidOrder(overrides?: Partial<Parameters<typeof Order.create>[0]>) {
  const defaults = {
    id: ORDER_ID,
    asset: TEST_ASSET,
    side: 'BUY' as const,
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('100')),
    timestamp: Timestamp.now(),
  };

  return Order.create({ ...defaults, ...overrides });
}

// Helper для создания FillData
function createFill(overrides?: Partial<FillData>): FillData {
  const defaults: FillData = {
    id: FILL_ID_1,
    orderId: ORDER_ID,
    asset: TEST_ASSET,
    side: 'BUY' as const,
    size: Quantity.of(new Decimal('30')),
    price: Price.of(new Decimal('0.65')),
  };

  return { ...defaults, ...overrides };
}

describe('Order', () => {
  describe('create()', () => {
    it('должен создать PENDING заявку с обязательными полями', () => {
      const result = createValidOrder();

      expect(result.ok).toBe(true);
      if (result.ok) {
        const order = result.value;
        expect(order.id).toBe(ORDER_ID);
        expect(order.asset).toEqual(TEST_ASSET);
        expect(order.side).toBe('BUY');
        expect(order.price.value().toNumber()).toBe(0.65);
        expect(order.size.value().toNumber()).toBe(100);
        expect(order.status).toBe('PENDING');
        expect(order.filledSize.isZero()).toBe(true);
        expect(order.fillIds).toEqual([]);
      }
    });

    it('должен вернуть Err для пустого id', () => {
      const result = createValidOrder({ id: '' as unknown as OrderId });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Order ID must be a non-empty string');
      }
    });

    it('должен вернуть Err при отсутствии asset', () => {
      const result = createValidOrder({ asset: undefined as unknown as AssetId });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Asset is required');
      }
    });

    it('должен вернуть Err для нулевого size', () => {
      const result = createValidOrder({ size: Quantity.of(new Decimal('0')) });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Order size must be positive');
      }
    });

    it('должен вернуть Err для невалидного side', () => {
      const result = createValidOrder({ side: 'INVALID' as 'BUY' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid side');
      }
    });

    it('должен создать заявку с опциональным strategyId', () => {
      const result = createValidOrder({ strategyId: unsafeStrategyId('strategy-1') });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.strategyId).toBe('strategy-1');
      }
    });

    it('всегда создаёт заявку со статусом PENDING', () => {
      const result = createValidOrder();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('PENDING');
        expect(result.value.isPending()).toBe(true);
      }
    });

    it('должен вернуть Err если price null', () => {
      const result = createValidOrder({ price: null as unknown as Price });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Price is required');
      }
    });

    it('должен вернуть Err если size null', () => {
      const result = createValidOrder({ size: null as unknown as Quantity });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Order size is required');
      }
    });
  });

  describe('rehydrate()', () => {
    function makeState(overrides?: Partial<OrderState>): OrderState {
      return {
        id: ORDER_ID,
        asset: TEST_ASSET,
        side: 'BUY',
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('100')),
        status: 'OPEN',
        timestamp: Timestamp.now(),
        fill: { filledSize: Quantity.of(new Decimal('0')), averagePrice: undefined, fillIds: [] },
        ...overrides,
      };
    }

    it('должен создать Order из валидного состояния', () => {
      const result = Order.rehydrate(makeState());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('OPEN');
      }
    });

    it('rehydrate() не должен эмитировать события', () => {
      const result = Order.rehydrate(makeState());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pullEvents(nextTestMetadata)).toHaveLength(0);
      }
    });

    it('должен вернуть Err если filledSize > size', () => {
      const state = makeState({
        fill: {
          filledSize: Quantity.of(new Decimal('150')),
          averagePrice: Price.of(new Decimal('0.65')),
          fillIds: [FILL_ID_1],
        },
      });
      const result = Order.rehydrate(state);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('filledSize');
    });

    it('должен вернуть Err для PENDING с fills', () => {
      const state = makeState({
        status: 'PENDING',
        fill: {
          filledSize: Quantity.of(new Decimal('10')),
          averagePrice: Price.of(new Decimal('0.65')),
          fillIds: [FILL_ID_1],
        },
      });
      const result = Order.rehydrate(state);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('PENDING');
    });

    it('должен вернуть Err для FILLED с неполным filledSize', () => {
      const state = makeState({
        status: 'FILLED',
        fill: {
          filledSize: Quantity.of(new Decimal('50')), // не равно size=100
          averagePrice: Price.of(new Decimal('0.65')),
          fillIds: [FILL_ID_1],
        },
      });
      const result = Order.rehydrate(state);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('FILLED');
    });

    it('должен принять FILLED со 100% filledSize', () => {
      const state = makeState({
        status: 'FILLED',
        fill: {
          filledSize: Quantity.of(new Decimal('100')),
          averagePrice: Price.of(new Decimal('0.65')),
          fillIds: [FILL_ID_1],
        },
      });
      const result = Order.rehydrate(state);
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err для PARTIALLY_FILLED с filledSize === 0', () => {
      const state = makeState({
        status: 'PARTIALLY_FILLED',
        fill: {
          filledSize: Quantity.of(new Decimal('0')),
          averagePrice: undefined,
          fillIds: [],
        },
      });
      const result = Order.rehydrate(state);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('PARTIALLY_FILLED');
    });

    it('должен вернуть Err для PARTIALLY_FILLED с filledSize === size', () => {
      const state = makeState({
        status: 'PARTIALLY_FILLED',
        fill: {
          filledSize: Quantity.of(new Decimal('100')), // равно size=100 — уже FILLED
          averagePrice: Price.of(new Decimal('0.65')),
          fillIds: [FILL_ID_1],
        },
      });
      const result = Order.rehydrate(state);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('PARTIALLY_FILLED');
    });
  });

  describe('fromSnapshot() через OrderDeserializer', () => {
    it('должен восстановить заявку из снэпшота', () => {
      const order = unwrap(createValidOrder());
      const snap = order.toSnapshot();
      const restored = unwrap(OrderDeserializer.fromSnapshot(snap));

      expect(restored.id).toBe(order.id);
      expect(restored.status).toBe(order.status);
      expect(restored.price.value().toNumber()).toBe(order.price.value().toNumber());
      expect(restored.size.value().toNumber()).toBe(order.size.value().toNumber());
    });

    it('должен восстановить заявку в статусе OPEN', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      const snap = open.toSnapshot();
      const restored = unwrap(OrderDeserializer.fromSnapshot(snap));

      expect(restored.status).toBe('OPEN');
    });

    it('должен восстановить частично заполненную заявку', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      const partial = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('30')) })));
      const snap = partial.toSnapshot();
      const restored = unwrap(OrderDeserializer.fromSnapshot(snap));

      expect(restored.status).toBe('PARTIALLY_FILLED');
      expect(restored.filledSize.value().toNumber()).toBe(30);
      expect(restored.averagePrice?.value().toNumber()).toBe(0.65);
      expect(restored.fillIds).toContain(FILL_ID_1);
    });

    it('должен вернуть Err для невалидного id', () => {
      const result = OrderDeserializer.fromSnapshot({ id: '' } as import('../../src/OrderState').OrderSnapshot);
      expect(result.ok).toBe(false);
    });
  });

  describe('fromEvents()', () => {
    it('должен воспроизвести заявку из событий', () => {
      const ts = Timestamp.now();
      const order = replay([
        {
          type: 'ORDER_CREATED',
          payload: {
            orderId: ORDER_ID,
            asset: TEST_ASSET,
            side: 'BUY',
            price: Price.of(new Decimal('0.65')),
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
      ]);

      expect(order.status).toBe('OPEN');
      expect(order.id).toBe(ORDER_ID);
    });

    it('должен вернуть Err для пустого массива событий', () => {
      const result = Order.fromEvents([]);
      expect(result.ok).toBe(false);
    });

    it('должен вернуть Err если первое событие не ORDER_CREATED', () => {
      const result = Order.fromEvents([
        {
          type: 'ORDER_ACCEPTED',
          payload: {
            orderId: ORDER_ID
          },
          metadata: nextTestMetadata(),
        },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('First event must be ORDER_CREATED');
      }
    });

    it('должен воспроизвести полный жизненный цикл с ORDER_FILLED', () => {
      const ts = Timestamp.now();
      const fill: FillData = {
        id: FILL_ID_1,
        orderId: ORDER_ID,
        asset: TEST_ASSET,
        side: 'BUY',
        size: Quantity.of(new Decimal('100')),
        price: Price.of(new Decimal('0.65')),
      };

      const order = replay([
        {
          type: 'ORDER_CREATED',
          payload: {
            orderId: ORDER_ID, asset: TEST_ASSET, side: 'BUY',
            price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('100')), timestamp: ts
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
            orderId: ORDER_ID, fill, averagePrice: fill.price
          },
          metadata: nextTestMetadata(),
        },
      ]);

      expect(order.status).toBe('FILLED');
      expect(order.filledSize.value().toNumber()).toBe(100);
    });

    it('должен воспроизвести частичное исполнение с ORDER_PARTIALLY_FILLED', () => {
      const ts = Timestamp.now();
      const fill: FillData = {
        id: FILL_ID_1,
        orderId: ORDER_ID,
        asset: TEST_ASSET,
        side: 'BUY',
        size: Quantity.of(new Decimal('30')),
        price: Price.of(new Decimal('0.65')),
      };
      const remainingSize = Quantity.of(new Decimal('70'));

      const order = replay([
        {
          type: 'ORDER_CREATED',
          payload: {
            orderId: ORDER_ID, asset: TEST_ASSET, side: 'BUY',
            price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('100')), timestamp: ts
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
          type: 'ORDER_PARTIALLY_FILLED',
          payload: {
            orderId: ORDER_ID, fill, filledSize: fill.size, remainingSize
          },
          metadata: nextTestMetadata(),
        },
      ]);

      expect(order.status).toBe('PARTIALLY_FILLED');
      expect(order.filledSize.value().toNumber()).toBe(30);
    });

    it('должен игнорировать fill после отмены заявки (нелегальный переход)', () => {
      const ts = Timestamp.now();
      const fillData: FillData = {
        id: asFillId('fill-1')!,
        orderId: ORDER_ID,
        asset: TEST_ASSET,
        side: 'BUY',
        size: Quantity.of(new Decimal('30')),
        price: Price.of(new Decimal('0.65')),
      };

      const order = replay([
        {
          type: 'ORDER_CREATED',
          payload: {
            orderId: ORDER_ID, asset: TEST_ASSET, side: 'BUY',
            price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('100')), timestamp: ts
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
          type: 'ORDER_PARTIALLY_FILLED',
          payload: {
            orderId: ORDER_ID, fill: fillData,
            filledSize: Quantity.of(new Decimal('30')),
            remainingSize: Quantity.of(new Decimal('70'))
          },
          metadata: nextTestMetadata(),
        },
        {
          type: 'ORDER_CANCELLED',
          payload: {
            orderId: ORDER_ID, reason: 'Risk limit'
          },
          metadata: nextTestMetadata(),
        },
        // fill после cancel — должен быть проигнорирован
        {
          type: 'ORDER_PARTIALLY_FILLED',
          payload: {
            orderId: ORDER_ID, fill: fillData,
            filledSize: Quantity.of(new Decimal('50')),
            remainingSize: Quantity.of(new Decimal('50'))
          },
          metadata: nextTestMetadata(),
        },
      ]);

      expect(order.status).toBe('CANCELED');
      expect(order.filledSize.value().toNumber()).toBe(30); // fill после cancel не применился
    });

    it('должен игнорировать ORDER_ACCEPTED если статус уже не PENDING', () => {
      const ts = Timestamp.now();
      const order = replay([
        {
          type: 'ORDER_CREATED',
          payload: {
            orderId: ORDER_ID, asset: TEST_ASSET, side: 'BUY',
            price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('100')), timestamp: ts
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
          type: 'ORDER_ACCEPTED',
          payload: {
            orderId: ORDER_ID
          },
          metadata: nextTestMetadata(),
        }, // дубль — должен быть проигнорирован
      ]);
      expect(order.status).toBe('OPEN');
    });

    it('должен игнорировать ORDER_REJECTED если статус уже не PENDING', () => {
      const ts = Timestamp.now();
      const order = replay([
        {
          type: 'ORDER_CREATED',
          payload: {
            orderId: ORDER_ID, asset: TEST_ASSET, side: 'BUY',
            price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('100')), timestamp: ts
          },
          metadata: nextTestMetadata(),
        },
        {
          type: 'ORDER_ACCEPTED',
          payload: {
            orderId: ORDER_ID
          },
          metadata: nextTestMetadata(),
        }, // уже OPEN
        {
          type: 'ORDER_REJECTED',
          payload: {
            orderId: ORDER_ID, reason: 'Too late'
          },
          metadata: nextTestMetadata(),
        }, // должен быть проигнорирован
      ]);
      expect(order.status).toBe('OPEN');
    });

    it('должен игнорировать ORDER_CANCELLED если статус не OPEN/PARTIALLY_FILLED', () => {
      const ts = Timestamp.now();
      const order = replay([
        {
          type: 'ORDER_CREATED',
          payload: {
            orderId: ORDER_ID, asset: TEST_ASSET, side: 'BUY',
            price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('100')), timestamp: ts
          },
          metadata: nextTestMetadata(),
        },
        // PENDING — не является fillable, ORDER_CANCELLED должен быть проигнорирован
        {
          type: 'ORDER_CANCELLED',
          payload: {
            orderId: ORDER_ID, reason: 'Too early'
          },
          metadata: nextTestMetadata(),
        },
      ]);
      expect(order.status).toBe('PENDING');
    });

    it('должен игнорировать ORDER_EXPIRED если статус терминальный', () => {
      const ts = Timestamp.now();
      const order = replay([
        {
          type: 'ORDER_CREATED',
          payload: {
            orderId: ORDER_ID, asset: TEST_ASSET, side: 'BUY',
            price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('100')), timestamp: ts
          },
          metadata: nextTestMetadata(),
        },
        {
          type: 'ORDER_REJECTED',
          payload: {
            orderId: ORDER_ID, reason: 'Invalid'
          },
          metadata: nextTestMetadata(),
        }, // REJECTED — терминальный
        {
          type: 'ORDER_EXPIRED',
          payload: {
            orderId: ORDER_ID
          },
          metadata: nextTestMetadata(),
        }, // должен быть проигнорирован
      ]);
      expect(order.status).toBe('REJECTED');
    });

    it('должен игнорировать событие с чужим orderId', () => {
      const FOREIGN_ID = asOrderId('order-foreign')!;
      const ts = Timestamp.now();
      const order = replay([
        {
          type: 'ORDER_CREATED',
          payload: {
            orderId: ORDER_ID, asset: TEST_ASSET, side: 'BUY',
            price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('100')), timestamp: ts
          },
          metadata: nextTestMetadata(),
        },
        {
          type: 'ORDER_ACCEPTED',
          payload: {
            orderId: FOREIGN_ID
          },
          metadata: nextTestMetadata(),
        }, // чужой orderId — должен быть проигнорирован
      ]);
      expect(order.status).toBe('PENDING'); // ORDER_ACCEPTED не применился
    });

    it('ORDER_FILLED с fill меньше размера заявки ставит статус FILLED в replay', () => {
      // В режиме replay тип события диктует статус — это намеренное поведение
      const ts = Timestamp.now();
      const fillData: FillData = {
        id: FILL_ID_1, orderId: ORDER_ID, asset: TEST_ASSET, side: 'BUY',
        size: Quantity.of(new Decimal('50')), // только половина заявки
        price: Price.of(new Decimal('0.65')),
      };
      const order = replay([
        {
          type: 'ORDER_CREATED',
          payload: {
            orderId: ORDER_ID, asset: TEST_ASSET, side: 'BUY',
            price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('100')), timestamp: ts
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
            orderId: ORDER_ID, fill: fillData,
            averagePrice: Price.of(new Decimal('0.65'))
          },
          metadata: nextTestMetadata(),
        },
      ]);
      expect(order.status).toBe('FILLED'); // тип события определяет статус при replay
      expect(order.filledSize.value().toNumber()).toBe(50);
    });

    it('должен игнорировать дублирующий fill в replay (addFill → Err)', () => {
      const ts = Timestamp.now();
      const fillData: FillData = {
        id: asFillId('fill-dup')!,
        orderId: ORDER_ID,
        asset: TEST_ASSET,
        side: 'BUY',
        size: Quantity.of(new Decimal('30')),
        price: Price.of(new Decimal('0.65')),
      };
      const partialEvent = {
        type: 'ORDER_PARTIALLY_FILLED' as const,
        payload: {
          orderId: ORDER_ID,
          fill: fillData,
          filledSize: Quantity.of(new Decimal('30')),
          remainingSize: Quantity.of(new Decimal('70')),
        },
        metadata: nextTestMetadata(),
      };
      const order = replay([
        {
          type: 'ORDER_CREATED',
          payload: {
            orderId: ORDER_ID, asset: TEST_ASSET, side: 'BUY',
            price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('100')), timestamp: ts
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
        partialEvent,
        partialEvent, // дубликат того же fill — должен быть проигнорирован
      ]);
      expect(order.filledSize.value().toNumber()).toBe(30); // второй fill не применился
      expect(order.status).toBe('PARTIALLY_FILLED');
    });

    it('fromEvents() не должен эмитировать события', () => {
      const ts = Timestamp.now();
      const order = replay([
        {
          type: 'ORDER_CREATED',
          payload: {
            orderId: ORDER_ID, asset: TEST_ASSET, side: 'BUY',
            price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('100')), timestamp: ts
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
      ]);

      expect(order.pullEvents(nextTestMetadata)).toHaveLength(0);
    });
  });

  describe('pullEvents()', () => {
    it('create() должен эмитировать ORDER_CREATED', () => {
      const result = createValidOrder();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const events = result.value.pullEvents(nextTestMetadata);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('ORDER_CREATED');
      }
    });

    it('pullEvents() должен очистить буфер после вызова', () => {
      const order = unwrap(createValidOrder());
      expect(order.pullEvents(nextTestMetadata)).toHaveLength(1); // ORDER_CREATED
      expect(order.pullEvents(nextTestMetadata)).toHaveLength(0); // буфер пуст
    });

    it('materialization атомарна: throw из metadataFor НЕ теряет события (outbox цел)', () => {
      // 1. Order с ДВУМЯ pending drafts: create (ORDER_CREATED) + accept (ORDER_ACCEPTED —
      //    accept() переносит накопленный буфер в новый экземпляр)
      const accepted = unwrap(unwrap(createValidOrder()).accept());

      // 2-3. Первая metadata создаётся успешно, вторая бросает
      let calls = 0;
      const failingOnSecond = () => {
        calls += 1;
        if (calls === 2) throw new Error('metadata failure on second event');
        return nextTestMetadata();
      };

      // 4. pullEvents пробрасывает исключение…
      expect(() => accepted.pullEvents(failingOnSecond)).toThrow('metadata failure on second event');

      // 5. …но outbox НЕ тронут: повторный pull с исправным поставщиком
      //    возвращает ОБА исходных события в исходном порядке
      const events = accepted.pullEvents(nextTestMetadata);
      expect(events.map((e) => e.type)).toEqual(['ORDER_CREATED', 'ORDER_ACCEPTED']);
      expect(events[0].metadata).toBeDefined();
      expect(events[1].metadata).toBeDefined();

      // 6. Следующий pull — буфер пуст
      expect(accepted.pullEvents(nextTestMetadata)).toHaveLength(0);
    });

    it('accept() должен эмитировать ORDER_ACCEPTED', () => {
      const order = unwrap(createValidOrder());
      order.pullEvents(nextTestMetadata); // очищаем ORDER_CREATED
      const accepted = unwrap(order.accept());
      const events = accepted.pullEvents(nextTestMetadata);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('ORDER_ACCEPTED');
    });

    it('reject() должен эмитировать ORDER_REJECTED', () => {
      const order = unwrap(createValidOrder());
      order.pullEvents(nextTestMetadata);
      const rejected = unwrap(order.reject('Bad price'));
      const events = rejected.pullEvents(nextTestMetadata);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('ORDER_REJECTED');
    });

    it('cancel() должен эмитировать ORDER_CANCELLED', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      open.pullEvents(nextTestMetadata);
      const canceled = unwrap(open.cancel('Risk limit'));
      const events = canceled.pullEvents(nextTestMetadata);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('ORDER_CANCELLED');
    });

    it('expire() должен эмитировать ORDER_EXPIRED', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      open.pullEvents(nextTestMetadata);
      const expired = unwrap(open.expire());
      const events = expired.pullEvents(nextTestMetadata);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('ORDER_EXPIRED');
    });

    it('applyFill() частичный → ORDER_PARTIALLY_FILLED', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      open.pullEvents(nextTestMetadata);
      const partial = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('30')) })));
      const events = partial.pullEvents(nextTestMetadata);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('ORDER_PARTIALLY_FILLED');
    });

    it('applyFill() полный → ORDER_FILLED', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      open.pullEvents(nextTestMetadata);
      const filled = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('100')) })));
      const events = filled.pullEvents(nextTestMetadata);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('ORDER_FILLED');
    });

    it('команды, вернувшие Err, не добавляют события в буфер источника', () => {
      const pending = unwrap(createValidOrder());
      pending.pullEvents(nextTestMetadata); // очищаем буфер ORDER_CREATED
      pending.cancel();     // Err — PENDING нельзя отменить
      pending.expire();     // Err — PENDING нельзя истечь
      expect(pending.pullEvents(nextTestMetadata)).toHaveLength(0); // Err не заполняет буфер
    });

    it('каждый Order инстанс имеет собственный буфер', () => {
      const order = unwrap(createValidOrder());
      const open = unwrap(order.accept()); // open._pendingEvents = [ORDER_CREATED, ORDER_ACCEPTED]

      // Оригинальный order содержит ORDER_CREATED
      const originalEvents = order.pullEvents(nextTestMetadata);
      expect(originalEvents).toHaveLength(1);
      expect(originalEvents[0]?.type).toBe('ORDER_CREATED');

      // open содержит ORDER_CREATED (carry-forward) + ORDER_ACCEPTED
      const openEvents = open.pullEvents(nextTestMetadata);
      expect(openEvents).toHaveLength(2);
      expect(openEvents[0]?.type).toBe('ORDER_CREATED');
      expect(openEvents[1]?.type).toBe('ORDER_ACCEPTED');
    });
  });

  describe('status predicates', () => {
    it('isPending() должен вернуть true для PENDING', () => {
      const order = unwrap(createValidOrder());
      expect(order.isPending()).toBe(true);
      expect(order.isOpen()).toBe(false);
      expect(order.isFilled()).toBe(false);
    });

    it('isOpen() должен вернуть true для OPEN', () => {
      const order = unwrap(unwrap(createValidOrder()).accept());
      expect(order.isOpen()).toBe(true);
      expect(order.isPending()).toBe(false);
    });

    it('isFilled() должен вернуть true для FILLED', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      const filled = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('100')) })));
      expect(filled.isFilled()).toBe(true);
      expect(filled.isOpen()).toBe(false);
    });

    it('isPartiallyFilled() должен вернуть true для PARTIALLY_FILLED', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      const partial = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('30')) })));
      expect(partial.isPartiallyFilled()).toBe(true);
    });

    it('canCancel() должен вернуть true для OPEN и PARTIALLY_FILLED', () => {
      const openOrder = unwrap(unwrap(createValidOrder()).accept());
      const partial = unwrap(openOrder.applyFill(createFill({ size: Quantity.of(new Decimal('30')) })));
      const filled = unwrap(openOrder.applyFill(createFill({ size: Quantity.of(new Decimal('100')) })));

      expect(openOrder.canCancel()).toBe(true);
      expect(partial.canCancel()).toBe(true);
      expect(filled.canCancel()).toBe(false);
    });

    it('canModify() должен вернуть true для нетерминальных статусов', () => {
      const openOrder = unwrap(unwrap(createValidOrder()).accept());
      const filled = unwrap(openOrder.applyFill(createFill({ size: Quantity.of(new Decimal('100')) })));
      const canceled = unwrap(openOrder.cancel());

      expect(openOrder.canModify()).toBe(true);
      expect(filled.canModify()).toBe(false);
      expect(canceled.canModify()).toBe(false);
    });

    it('isTerminal должен вернуть true для терминальных статусов', () => {
      const order = unwrap(createValidOrder());
      expect(order.isTerminal).toBe(false);
      const open = unwrap(order.accept());
      expect(open.isTerminal).toBe(false);
      const filled = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('100')) })));
      expect(filled.isTerminal).toBe(true);
    });

    it('isFillable должен вернуть true для OPEN и PARTIALLY_FILLED', () => {
      const pending = unwrap(createValidOrder());
      const open = unwrap(pending.accept());
      const partial = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('30')) })));

      expect(pending.isFillable).toBe(false);
      expect(open.isFillable).toBe(true);
      expect(partial.isFillable).toBe(true);
    });
  });

  describe('computed getters', () => {
    it('notional должен вычислять price * size', () => {
      const order = unwrap(createValidOrder({
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('100')),
      }));

      expect(order.notional.toNumber()).toBe(65);
    });

    it('remainingSize должен вернуть незаполненный объём', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      const partial = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('30')) })));

      expect(partial.remainingSize.value().toNumber()).toBe(70);
    });

    it('fillPercentage должен вычислять процент заполнения', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      const partial = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('30')) })));

      expect(partial.fillPercentage.toNumber()).toBe(30);
    });

    it('tradeCount должен вернуть количество fills', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      const after1 = unwrap(open.applyFill(createFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('30')) })));
      const after2 = unwrap(after1.applyFill(createFill({ id: FILL_ID_2, size: Quantity.of(new Decimal('20')) })));

      expect(after2.tradeCount).toBe(2);
    });

    it('timestamp геттер возвращает переданный объект Timestamp', () => {
      const ts = Timestamp.now();
      const order = unwrap(createValidOrder({ timestamp: ts }));
      expect(order.timestamp).toBe(ts); // та же ссылка, не просто defined
    });

    it('fillPercentage возвращает 0 если size равен нулю (защитная ветка)', () => {
      const emptyFill: FillState = { filledSize: Quantity.ZERO, averagePrice: undefined, fillIds: [] };
      const state: OrderState = {
        id: ORDER_ID,
        asset: TEST_ASSET,
        side: 'BUY',
        price: Price.of(new Decimal('0.65')),
        size: Quantity.ZERO,
        status: 'PENDING',
        timestamp: Timestamp.now(),
        fill: emptyFill,
      };
      const order = unwrap(Order.rehydrate(state));
      expect(order.fillPercentage.toNumber()).toBe(0);
    });

    it('applyFill должен вернуть ошибку для fill с нулевым размером', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      const zeroFill = createFill({ size: Quantity.of(new Decimal('0')) });
      const result = open.applyFill(zeroFill);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('positive');
    });

    it('filledSize, averagePrice, fillIds доступны напрямую', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      const partial = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('30')) })));

      expect(partial.filledSize.value().toNumber()).toBe(30);
      expect(partial.averagePrice?.value().toNumber()).toBe(0.65);
      expect(partial.fillIds).toContain(FILL_ID_1);
    });

    it('fill.filledSize доступно через fill геттер', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      const partial = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('30')) })));

      expect(partial.fill.filledSize.value().toNumber()).toBe(30);
      expect(partial.fill.averagePrice?.value().toNumber()).toBe(0.65);
      expect(partial.fill.fillIds).toContain(FILL_ID_1);
    });
  });

  describe('FSM transitions', () => {
    describe('accept()', () => {
      it('должен перейти PENDING → OPEN', () => {
        const order = unwrap(createValidOrder());
        const result = order.accept();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('OPEN');
          expect(result.value.id).toBe(order.id);
        }
      });

      it('должен вернуть Err для не-PENDING статуса', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        expect(order.accept().ok).toBe(false);
      });
    });

    describe('reject()', () => {
      it('должен перейти PENDING → REJECTED с причиной', () => {
        const order = unwrap(createValidOrder());
        const result = order.reject('Insufficient funds');

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('REJECTED');
          expect(result.value.reason).toBe('Insufficient funds');
        }
      });

      it('должен вернуть Err без причины', () => {
        const order = unwrap(createValidOrder());
        const result = order.reject('');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Reject reason must be a non-empty string');
        }
      });

      it('должен вернуть Err для не-PENDING статуса', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        expect(order.reject('Some reason').ok).toBe(false);
      });
    });

    describe('cancel()', () => {
      it('должен перейти OPEN → CANCELED', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        const result = order.cancel('User request');

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('CANCELED');
          expect(result.value.reason).toBe('User request');
        }
      });

      it('должен использовать дефолтную причину если не указана', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        const result = order.cancel();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.reason).toBe('User cancelled');
        }
      });

      it('должен вернуть Err для терминального статуса', () => {
        const open = unwrap(unwrap(createValidOrder()).accept());
        const filled = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('100')) })));
        expect(filled.cancel().ok).toBe(false);
      });
    });

    describe('expire()', () => {
      it('должен перейти OPEN → EXPIRED', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        const result = order.expire();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('EXPIRED');
        }
      });

      it('должен вернуть Err для терминального статуса', () => {
        const open = unwrap(unwrap(createValidOrder()).accept());
        const filled = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('100')) })));
        expect(filled.expire().ok).toBe(false);
      });
    });

    describe('applyFill()', () => {
      it('должен перейти OPEN → PARTIALLY_FILLED при частичном заполнении', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        const fill = createFill({ size: Quantity.of(new Decimal('30')) });

        const result = order.applyFill(fill);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('PARTIALLY_FILLED');
          expect(result.value.filledSize.value().toNumber()).toBe(30);
          expect(result.value.remainingSize.value().toNumber()).toBe(70);
        }
      });

      it('должен перейти OPEN → FILLED при полном заполнении', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        const fill = createFill({ size: Quantity.of(new Decimal('100')) });

        const result = order.applyFill(fill);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('FILLED');
          expect(result.value.filledSize.value().toNumber()).toBe(100);
          expect(result.value.remainingSize.value().toNumber()).toBe(0);
        }
      });

      it('должен накапливать несколько fills', () => {
        let order = unwrap(unwrap(createValidOrder()).accept());

        const fill1 = createFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('30')) });
        order = unwrap(order.applyFill(fill1));
        expect(order.status).toBe('PARTIALLY_FILLED');
        expect(order.filledSize.value().toNumber()).toBe(30);

        const fill2 = createFill({ id: FILL_ID_2, size: Quantity.of(new Decimal('20')) });
        order = unwrap(order.applyFill(fill2));
        expect(order.status).toBe('PARTIALLY_FILLED');
        expect(order.filledSize.value().toNumber()).toBe(50);

        const fill3 = createFill({ id: FILL_ID_3, size: Quantity.of(new Decimal('50')) });
        order = unwrap(order.applyFill(fill3));
        expect(order.status).toBe('FILLED');
        expect(order.filledSize.value().toNumber()).toBe(100);
      });

      it('должен вернуть Err для дублирующего fill ID', () => {
        let order = unwrap(unwrap(createValidOrder()).accept());

        const fill1 = createFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('30')) });
        order = unwrap(order.applyFill(fill1));

        const fill2 = createFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('20')) });
        expect(order.applyFill(fill2).ok).toBe(false);
      });

      it('должен вернуть Err если fill превышает остаток', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        const fill = createFill({ size: Quantity.of(new Decimal('150')) });

        expect(order.applyFill(fill).ok).toBe(false);
      });

      it('должен вернуть Err для терминального статуса', () => {
        const open = unwrap(unwrap(createValidOrder()).accept());
        const filled = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('100')) })));
        expect(filled.applyFill(createFill()).ok).toBe(false);
      });

      it('должен вернуть Err если asset fill не совпадает', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        const fill = createFill({
          asset: { ...TEST_ASSET, outcomeKey: parseOutcomeKey('NO')! },
        });
        const result = order.applyFill(fill);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain('asset');
      });

      it('должен вернуть Err если side fill не совпадает', () => {
        const order = unwrap(unwrap(createValidOrder({ side: 'BUY' })).accept());
        const fill = createFill({ side: 'SELL' });
        const result = order.applyFill(fill);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain('side');
      });

      it('должен вернуть Err если orderId fill не совпадает', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        const fill = createFill({ orderId: asOrderId('other-order')! });
        const result = order.applyFill(fill);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain('orderId');
      });
    });

    describe('canAcceptFill()', () => {
      it('должен вернуть true для валидного fill', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        const validFill = createFill({ size: Quantity.of(new Decimal('30')) });
        const invalidFill = createFill({ size: Quantity.of(new Decimal('150')) });

        expect(order.canAcceptFill(validFill)).toBe(true);
        expect(order.canAcceptFill(invalidFill)).toBe(false);
      });

      it('должен отклонить fill с неверным orderId', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        const fill = createFill({ orderId: asOrderId('wrong-order')! });
        expect(order.canAcceptFill(fill)).toBe(false);
      });

      it('должен отклонить fill с неверным side', () => {
        const order = unwrap(unwrap(createValidOrder({ side: 'BUY' })).accept());
        const fill = createFill({ side: 'SELL' });
        expect(order.canAcceptFill(fill)).toBe(false);
      });

      it('должен отклонить fill с неверным asset', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        const otherAsset: AssetId = {
          ...TEST_ASSET,
          outcomeKey: parseOutcomeKey('NO')!,
        };
        const fill = createFill({ asset: otherAsset });
        expect(order.canAcceptFill(fill)).toBe(false);
      });

      it('должен отклонить fill с нулевым size', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        const fill = createFill({ size: Quantity.of(new Decimal('0')) });
        expect(order.canAcceptFill(fill)).toBe(false);
      });

      it('должен отклонить fill для PENDING статуса', () => {
        const order = unwrap(createValidOrder());
        expect(order.canAcceptFill(createFill())).toBe(false);
      });

      it('должен отклонить уже применённый fill ID', () => {
        let order = unwrap(unwrap(createValidOrder()).accept());
        const fill = createFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('30')) });
        order = unwrap(order.applyFill(fill));

        expect(order.canAcceptFill(fill)).toBe(false);
      });

      it('паритет canAcceptFill и applyFill', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());

        const oversized = createFill({ size: Quantity.of(new Decimal('150')) });
        expect(order.canAcceptFill(oversized)).toBe(false);
        expect(order.applyFill(oversized).ok).toBe(false);

        const wrongOrder = createFill({ orderId: asOrderId('other-order')! });
        expect(order.canAcceptFill(wrongOrder)).toBe(false);
        expect(order.applyFill(wrongOrder).ok).toBe(false);
      });
    });
  });

  describe('иммутабельность', () => {
    it('должен вернуть новый экземпляр при изменении статуса', () => {
      const original = unwrap(createValidOrder());
      const result = original.accept();

      expect(result.ok).toBe(true);
      const accepted = unwrap(result);

      expect(original.status).toBe('PENDING');
      expect(accepted.status).toBe('OPEN');
      expect(accepted.id).toBe(original.id);
    });
  });

  describe('сериализация', () => {
    it('toSnapshot() должен сериализовать заявку', () => {
      const order = unwrap(unwrap(createValidOrder({ id: ORDER_ID })).accept());

      const snap = order.toSnapshot();

      expect(snap.id).toBe(ORDER_ID);
      expect(snap.status).toBe('OPEN');
      expect(snap.price).toBe(0.65);
      expect(snap.size).toBe(100);
      expect(snap.filledSize).toBe(0);
    });

    it('round-trip toSnapshot → fromSnapshot должен сохранить все поля', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      const partial = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('30')) })));

      const restored = unwrap(OrderDeserializer.fromSnapshot(partial.toSnapshot()));

      expect(restored.status).toBe('PARTIALLY_FILLED');
      expect(restored.filledSize.value().toNumber()).toBe(30);
      expect(restored.averagePrice?.value().toNumber()).toBe(0.65);
    });

    it('toString() должен включать основные поля', () => {
      const order = unwrap(unwrap(createValidOrder({
        id: ORDER_ID,
        side: 'BUY',
        size: Quantity.of(new Decimal('100')),
        price: Price.of(new Decimal('0.65')),
      })).accept());

      const str = order.toString();

      expect(str).toContain('order-123');
      expect(str).toContain('BUY');
      expect(str).toContain('100');
      expect(str).toContain('0.65');
      expect(str).toContain('OPEN');
    });
  });
});

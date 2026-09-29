/**
 * Тесты для Order aggregate
 */

import { OutcomePrice, Quantity } from '@polymarket/value-objects';
import { Timestamp } from '@polymarket/timestamp';
import type { AssetId, OrderId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
import {
  accountIdFromWallet,
  asOrderId,
  asFillId,
  parseConditionId,
  parseWalletAddress,
  parseOutcomeKey,
  KnownChainIds,
  KnownOnChainProtocols,
} from '@polymarket/ids';
import Decimal from 'decimal.js';
import { Order } from '../../src/Order';
import { OrderDeserializer } from '../../src/view/OrderDeserializer';
import type { FillState, OrderState } from '../../src/OrderState';
import type { FillData } from '@polymarket/fill';

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
    price: OutcomePrice.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('100')),
    timestamp: Timestamp.now(),
  };

  return Order.create({ ...defaults, ...overrides });
}

// Helper: заявка в заданном статусе через доверенное восстановление
function orderInStatus(status: OrderState['status']): Order {
  const filledSize = status === 'FILLED' ? '100' : status === 'PARTIALLY_FILLED' ? '40' : '0';
  const hasFills = filledSize !== '0';
  return unwrap(Order.rehydrate({
    id: ORDER_ID,
    asset: TEST_ASSET,
    side: 'BUY',
    price: OutcomePrice.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('100')),
    status,
    timestamp: Timestamp.now(),
    fill: {
      filledSize: Quantity.of(new Decimal(filledSize)),
      averagePrice: hasFills ? OutcomePrice.of(new Decimal('0.65')) : undefined,
      fillIds: hasFills ? [FILL_ID_1] : [],
    },
  }), `orderInStatus(${status})`);
}

// Helper для создания FillData
function createFill(overrides?: Partial<FillData>): FillData {
  const defaults: FillData = {
    id: FILL_ID_1,
    orderId: ORDER_ID,
    asset: TEST_ASSET,
    side: 'BUY' as const,
    size: Quantity.of(new Decimal('30')),
    price: OutcomePrice.of(new Decimal('0.65')),
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
      const result = createValidOrder({ price: null as unknown as OutcomePrice });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('OutcomePrice is required');
      }
    });

    it('должен вернуть Err если size null', () => {
      const result = createValidOrder({ size: null as unknown as Quantity });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Order size is required');
      }
    });

    it('должен вернуть Err если timestamp отсутствует', () => {
      const result = createValidOrder({ timestamp: undefined as unknown as Timestamp });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Timestamp is required');
      }
    });

    it('новая заявка: пустое fill-состояние, без причины, владелец и стратегия перенесены', () => {
      const wallet = parseWalletAddress('0x1234567890abcdef1234567890abcdef12345678')!;
      const accountId = accountIdFromWallet(wallet);
      const order = unwrap(createValidOrder({
        strategyId: unsafeStrategyId('strategy-1'),
        accountId,
      }));

      expect(order.status).toBe('PENDING');
      expect(order.filledSize.isZero()).toBe(true);
      expect(order.averagePrice).toBeUndefined();
      expect(order.fillIds).toEqual([]);
      expect(order.tradeCount).toBe(0);
      expect(order.reason).toBeUndefined();
      expect(order.strategyId).toBe('strategy-1');
      expect(order.accountId).toBe(accountId);
    });
  });

  describe('rehydrate()', () => {
    function makeState(overrides?: Partial<OrderState>): OrderState {
      return {
        id: ORDER_ID,
        asset: TEST_ASSET,
        side: 'BUY',
        price: OutcomePrice.of(new Decimal('0.65')),
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

    it('должен вернуть Err если filledSize > size', () => {
      const state = makeState({
        fill: {
          filledSize: Quantity.of(new Decimal('150')),
          averagePrice: OutcomePrice.of(new Decimal('0.65')),
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
          averagePrice: OutcomePrice.of(new Decimal('0.65')),
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
          averagePrice: OutcomePrice.of(new Decimal('0.65')),
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
          averagePrice: OutcomePrice.of(new Decimal('0.65')),
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
          averagePrice: OutcomePrice.of(new Decimal('0.65')),
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
        price: OutcomePrice.of(new Decimal('0.65')),
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
        price: OutcomePrice.of(new Decimal('0.65')),
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

      it.each(['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'] as const)(
        'должен вернуть Err из статуса %s',
        (status) => {
          const result = orderInStatus(status).accept();
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.message).toContain('Only PENDING orders can be accepted');
        },
      );
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

      it('должен вернуть Err для причины из одних пробелов', () => {
        const result = unwrap(createValidOrder()).reject('   ');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain('Reject reason must be a non-empty string');
      });

      it('должен вернуть Err для не-PENDING статуса', () => {
        const order = unwrap(unwrap(createValidOrder()).accept());
        expect(order.reject('Some reason').ok).toBe(false);
      });

      it.each(['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'] as const)(
        'должен вернуть Err из статуса %s',
        (status) => {
          const result = orderInStatus(status).reject('Too late');
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.message).toContain('Only PENDING orders can be rejected');
        },
      );
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

      it('должен перейти PARTIALLY_FILLED → CANCELED, сохранив fill-состояние', () => {
        const open = unwrap(unwrap(createValidOrder()).accept());
        const partial = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('30')) })));
        const canceled = unwrap(partial.cancel('Risk limit'));

        expect(canceled.status).toBe('CANCELED');
        expect(canceled.reason).toBe('Risk limit');
        expect(canceled.filledSize.value().toNumber()).toBe(30);
        expect(canceled.averagePrice?.value().toNumber()).toBe(0.65);
        expect(canceled.fillIds).toEqual([FILL_ID_1]);
      });

      it('должен вернуть Err для терминального статуса', () => {
        const open = unwrap(unwrap(createValidOrder()).accept());
        const filled = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('100')) })));
        expect(filled.cancel().ok).toBe(false);
      });

      it.each(['PENDING', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'] as const)(
        'должен вернуть Err из статуса %s',
        (status) => {
          const result = orderInStatus(status).cancel();
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.message).toContain('Only OPEN or PARTIALLY_FILLED orders can be cancelled');
        },
      );
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

      it('должен перейти PARTIALLY_FILLED → EXPIRED, сохранив fill-состояние', () => {
        const open = unwrap(unwrap(createValidOrder()).accept());
        const partial = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('30')) })));
        const expired = unwrap(partial.expire());

        expect(expired.status).toBe('EXPIRED');
        expect(expired.filledSize.value().toNumber()).toBe(30);
        expect(expired.fillIds).toEqual([FILL_ID_1]);
      });

      it('должен вернуть Err для терминального статуса', () => {
        const open = unwrap(unwrap(createValidOrder()).accept());
        const filled = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('100')) })));
        expect(filled.expire().ok).toBe(false);
      });

      it.each(['PENDING', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'] as const)(
        'должен вернуть Err из статуса %s',
        (status) => {
          const result = orderInStatus(status).expire();
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.message).toContain('Only OPEN or PARTIALLY_FILLED orders can expire');
        },
      );
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

      it.each(['PENDING', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'] as const)(
        'должен вернуть Err из статуса %s',
        (status) => {
          const result = orderInStatus(status).applyFill(createFill({ id: FILL_ID_2 }));
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.message).toContain('Only OPEN or PARTIALLY_FILLED orders can accept fills');
        },
      );

      it('должен вернуть Err с причиной для дублирующего fill ID и превышения остатка', () => {
        const partial = unwrap(unwrap(unwrap(createValidOrder()).accept())
          .applyFill(createFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('30')) })));

        const duplicate = partial.applyFill(createFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('10')) }));
        expect(duplicate.ok).toBe(false);
        if (!duplicate.ok) expect(duplicate.error.message).toContain('Duplicate fill id');

        const oversized = partial.applyFill(createFill({ id: FILL_ID_2, size: Quantity.of(new Decimal('71')) }));
        expect(oversized.ok).toBe(false);
        if (!oversized.ok) expect(oversized.error.message).toContain('exceeds remaining size');
      });

      it('PARTIALLY_FILLED → PARTIALLY_FILLED, пока остаток не исчерпан', () => {
        const open = unwrap(unwrap(createValidOrder()).accept());
        const first = unwrap(open.applyFill(createFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('30')) })));
        const second = unwrap(first.applyFill(createFill({ id: FILL_ID_2, size: Quantity.of(new Decimal('20')) })));

        expect(second.status).toBe('PARTIALLY_FILLED');
        expect(second.fillIds).toEqual([FILL_ID_1, FILL_ID_2]);
        expect(second.remainingSize.value().toNumber()).toBe(50);
      });

      it('должен считать VWAP по всем fills', () => {
        const open = unwrap(unwrap(createValidOrder()).accept());
        const after1 = unwrap(open.applyFill(createFill({
          id: FILL_ID_1, size: Quantity.of(new Decimal('40')), price: OutcomePrice.of(new Decimal('0.55')),
        })));
        expect(after1.averagePrice?.value().toString()).toBe('0.55');

        const after2 = unwrap(after1.applyFill(createFill({
          id: FILL_ID_2, size: Quantity.of(new Decimal('60')), price: OutcomePrice.of(new Decimal('0.65')),
        })));

        // (40 × 0.55 + 60 × 0.65) / 100 = (22 + 39) / 100 = 0.61
        expect(after2.status).toBe('FILLED');
        expect(after2.averagePrice?.value().toString()).toBe('0.61');
      });

      it('остаток меньше порога пыли (0.01) переводит заявку в FILLED', () => {
        const open = unwrap(unwrap(createValidOrder({
          size: Quantity.of(new Decimal('5.071832064')),
        })).accept());
        const filled = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('5.07')) })));

        expect(filled.status).toBe('FILLED');
        expect(filled.filledSize.value().toString()).toBe('5.07');
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

      expect(accepted).not.toBe(original);
      expect(original.status).toBe('PENDING');
      expect(accepted.status).toBe('OPEN');
      expect(accepted.id).toBe(original.id);
    });

    it('applyFill не меняет исходную заявку, fill есть только в возвращённой', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      const before = open.toSnapshot();

      const partial = unwrap(open.applyFill(createFill({ size: Quantity.of(new Decimal('30')) })));

      expect(open.toSnapshot()).toEqual(before);
      expect(open.status).toBe('OPEN');
      expect(open.filledSize.isZero()).toBe(true);
      expect(open.averagePrice).toBeUndefined();
      expect(open.fillIds).toEqual([]);

      expect(partial.status).toBe('PARTIALLY_FILLED');
      expect(partial.filledSize.value().toNumber()).toBe(30);
      expect(partial.fillIds).toEqual([FILL_ID_1]);
    });

    it('reject/cancel/expire не меняют исходную заявку', () => {
      const pending = unwrap(createValidOrder());
      const rejected = unwrap(pending.reject('Bad price'));
      expect(pending.status).toBe('PENDING');
      expect(pending.reason).toBeUndefined();
      expect(rejected.status).toBe('REJECTED');

      const open = unwrap(pending.accept());
      const canceled = unwrap(open.cancel('Risk limit'));
      const expired = unwrap(open.expire());
      expect(open.status).toBe('OPEN');
      expect(open.reason).toBeUndefined();
      expect(canceled.status).toBe('CANCELED');
      expect(expired.status).toBe('EXPIRED');
    });

    it('команда, вернувшая Err, не меняет заявку', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());
      const before = open.toSnapshot();

      expect(open.accept().ok).toBe(false);
      expect(open.reject('Too late').ok).toBe(false);
      expect(open.applyFill(createFill({ size: Quantity.of(new Decimal('150')) })).ok).toBe(false);

      expect(open.toSnapshot()).toEqual(before);
    });

    it('с одной заявки можно разветвить несколько независимых переходов', () => {
      const open = unwrap(unwrap(createValidOrder()).accept());

      const fillA = unwrap(open.applyFill(createFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('30')) })));
      const fillB = unwrap(open.applyFill(createFill({ id: FILL_ID_2, size: Quantity.of(new Decimal('50')) })));

      expect(fillA.fillIds).toEqual([FILL_ID_1]);
      expect(fillB.fillIds).toEqual([FILL_ID_2]);
      expect(open.fillIds).toEqual([]);
    });

    it('экземпляр не несёт иного состояния, кроме OrderState', () => {
      // Регрессия против возврата скрытого изменяемого буфера (бывший outbox
      // драфтов доменных событий): единственное собственное поле — `_s`.
      const order = unwrap(unwrap(createValidOrder()).accept());
      expect(Object.keys(order)).toEqual(['_s']);
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
        price: OutcomePrice.of(new Decimal('0.65')),
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

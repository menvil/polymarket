/**
 * Тесты для Order entity
 */

import { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import type { AssetId } from '@polymarket/ids';
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
import { OrderFill } from '../../src/value-objects/OrderFill';
import type { FillForOrder } from '../../src/types/OrderChange';

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
const TRADE_ID_1 = asFillId('trade-1')!;

// Helper для создания валидного Order
function createValidOrder(overrides?: Partial<Parameters<typeof Order.create>[0]>) {
  const defaults = {
    id: ORDER_ID,
    asset: TEST_ASSET,
    side: 'BUY' as const,
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('100')),
    status: 'PENDING' as const,
    timestamp: Timestamp.now(),
  };

  return Order.create({ ...defaults, ...overrides });
}

// Helper для создания FillForOrder object
function createFill(overrides?: Partial<FillForOrder>): FillForOrder {
  const defaults: FillForOrder = {
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
    it('should create valid order with all required fields', () => {
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
        expect(order.fill.isEmpty()).toBe(true);
      }
    });

    it('should fail with empty id', () => {
      const result = createValidOrder({ id: asOrderId('') });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Order ID must be a non-empty string');
      }
    });

    it('should fail with missing asset', () => {
      const result = createValidOrder({ asset: undefined as unknown as AssetId });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Asset is required');
      }
    });

    it('should throw for negative size (Quantity invariant)', () => {
      // Quantity.of() throws QuantityInvariantViolation for negative values
      expect(() => Quantity.of(new Decimal('-10'))).toThrow();
    });

    it('should fail with zero size', () => {
      const result = createValidOrder({ size: Quantity.of(new Decimal('0')) });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Order size must be positive');
      }
    });

    it('should fail with invalid side', () => {
      const result = createValidOrder({ side: 'INVALID' as 'BUY' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid side');
      }
    });

    it('should fail with invalid status', () => {
      const result = createValidOrder({ status: 'UNKNOWN' as 'PENDING' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid status');
      }
    });

    it('should create order with optional strategyId', () => {
      const result = createValidOrder({ strategyId: 'strategy-1' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.strategyId).toBe('strategy-1');
      }
    });

    it('should create order with fill', () => {
      const fill = unwrap(OrderFill.create(
        Quantity.of(new Decimal('30')),
        Price.of(new Decimal('0.65')),
        [TRADE_ID_1],
        Quantity.of(new Decimal('100'))
      ), 'OrderFill.create');

      const result = createValidOrder({ fill, status: 'PARTIALLY_FILLED' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.fill.getFilledSize().value().toNumber()).toBe(30);
      }
    });
  });

  describe('status predicates', () => {
    it('isPending() should return true for PENDING status', () => {
      const order = unwrap(createValidOrder({ status: 'PENDING' }), 'createValidOrder PENDING');
      expect(order.isPending()).toBe(true);
      expect(order.isOpen()).toBe(false);
      expect(order.isFilled()).toBe(false);
    });

    it('isOpen() should return true for OPEN status', () => {
      const order = unwrap(createValidOrder({ status: 'OPEN' }), 'createValidOrder OPEN');
      expect(order.isOpen()).toBe(true);
      expect(order.isPending()).toBe(false);
    });

    it('isFilled() should return true for FILLED status', () => {
      const order = unwrap(createValidOrder({ status: 'FILLED' }), 'createValidOrder FILLED');
      expect(order.isFilled()).toBe(true);
      expect(order.isOpen()).toBe(false);
    });

    it('isPartiallyFilled() should detect partial fill', () => {
      const fill = unwrap(OrderFill.create(
        Quantity.of(new Decimal('30')),
        Price.of(new Decimal('0.65')),
        [TRADE_ID_1],
        Quantity.of(new Decimal('100'))
      ), 'OrderFill.create');

      const order = unwrap(createValidOrder({ fill, status: 'PARTIALLY_FILLED' }), 'createValidOrder PARTIALLY_FILLED');
      expect(order.isPartiallyFilled()).toBe(true);
    });

    it('canCancel() should return true for OPEN and PARTIALLY_FILLED', () => {
      const openOrder = unwrap(createValidOrder({ status: 'OPEN' }));
      const partialOrder = unwrap(createValidOrder({ status: 'PARTIALLY_FILLED' }));
      const filledOrder = unwrap(createValidOrder({ status: 'FILLED' }));

      expect(openOrder.canCancel()).toBe(true);
      expect(partialOrder.canCancel()).toBe(true);
      expect(filledOrder.canCancel()).toBe(false);
    });

    it('canModify() should return true for non-terminal statuses', () => {
      const openOrder = unwrap(createValidOrder({ status: 'OPEN' }));
      const filledOrder = unwrap(createValidOrder({ status: 'FILLED' }));
      const canceledOrder = unwrap(createValidOrder({ status: 'CANCELED' }));

      expect(openOrder.canModify()).toBe(true);
      expect(filledOrder.canModify()).toBe(false);
      expect(canceledOrder.canModify()).toBe(false);
    });
  });

  describe('calculations', () => {
    it('getNotional() should calculate price * size', () => {
      const order = unwrap(createValidOrder({
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('100')),
      }));

      const notional = order.getNotional();
      expect(notional.toNumber()).toBe(65);
    });

    it('getRemainingSize() should return unfilled amount', () => {
      const fill = unwrap(OrderFill.create(
        Quantity.of(new Decimal('30')),
        Price.of(new Decimal('0.65')),
        [TRADE_ID_1],
        Quantity.of(new Decimal('100'))
      ), 'OrderFill.create');

      const order = unwrap(createValidOrder({ fill, status: 'PARTIALLY_FILLED' }));

      const remaining = order.getRemainingSize();
      expect(remaining.value().toNumber()).toBe(70);
    });

    it('getFillPercentage() should calculate percentage', () => {
      const fill = unwrap(OrderFill.create(
        Quantity.of(new Decimal('30')),
        Price.of(new Decimal('0.65')),
        [TRADE_ID_1],
        Quantity.of(new Decimal('100'))
      ), 'OrderFill.create');

      const order = unwrap(createValidOrder({ fill, status: 'PARTIALLY_FILLED' }));

      const percentage = order.getFillPercentage();
      expect(percentage.toNumber()).toBe(30);
    });

    it('getTradeCount() should return number of fills', () => {
      const fill = unwrap(OrderFill.create(
        Quantity.of(new Decimal('30')),
        Price.of(new Decimal('0.65')),
        [FILL_ID_1, FILL_ID_2],
        Quantity.of(new Decimal('100'))
      ), 'OrderFill.create');

      const order = unwrap(createValidOrder({ fill }));
      expect(order.getTradeCount()).toBe(2);
    });

    it('hasFill() should check for fill existence', () => {
      const fill = unwrap(OrderFill.create(
        Quantity.of(new Decimal('30')),
        Price.of(new Decimal('0.65')),
        [FILL_ID_1],
        Quantity.of(new Decimal('100'))
      ), 'OrderFill.create');

      const order = unwrap(createValidOrder({ fill }));
      expect(order.hasFill(FILL_ID_1)).toBe(true);
      expect(order.hasFill(FILL_ID_2)).toBe(false);
    });
  });

  describe('FSM transitions', () => {
    describe('accept()', () => {
      it('should transition PENDING → OPEN', () => {
        const order = unwrap(createValidOrder({ status: 'PENDING' }));
        const result = order.accept();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('OPEN');
          expect(result.value.id).toBe(order.id); // Same ID
        }
      });

      it('should fail for non-PENDING status', () => {
        const order = unwrap(createValidOrder({ status: 'OPEN' }));
        const result = order.accept();

        expect(result.ok).toBe(false);
      });
    });

    describe('reject()', () => {
      it('should transition PENDING → REJECTED with reason', () => {
        const order = unwrap(createValidOrder({ status: 'PENDING' }));
        const result = order.reject('Insufficient funds');

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('REJECTED');
          expect(result.value.reason).toBe('Insufficient funds');
        }
      });

      it('should fail without reason', () => {
        const order = unwrap(createValidOrder({ status: 'PENDING' }));
        const result = order.reject('');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Reject reason must be a non-empty string');
        }
      });

      it('should fail for non-PENDING status', () => {
        const order = unwrap(createValidOrder({ status: 'OPEN' }));
        const result = order.reject('Some reason');

        expect(result.ok).toBe(false);
      });
    });

    describe('cancel()', () => {
      it('should transition OPEN → CANCELED', () => {
        const order = unwrap(createValidOrder({ status: 'OPEN' }));
        const result = order.cancel('User request');

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('CANCELED');
          expect(result.value.reason).toBe('User request');
        }
      });

      it('should use default reason if not provided', () => {
        const order = unwrap(createValidOrder({ status: 'OPEN' }));
        const result = order.cancel();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.reason).toBe('User cancelled');
        }
      });

      it('should fail for terminal status', () => {
        const order = unwrap(createValidOrder({ status: 'FILLED' }));
        const result = order.cancel();

        expect(result.ok).toBe(false);
      });
    });

    describe('expire()', () => {
      it('should transition OPEN → EXPIRED', () => {
        const order = unwrap(createValidOrder({ status: 'OPEN' }));
        const result = order.expire();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('EXPIRED');
        }
      });

      it('should fail for terminal status', () => {
        const order = unwrap(createValidOrder({ status: 'FILLED' }));
        const result = order.expire();

        expect(result.ok).toBe(false);
      });
    });

    describe('applyFill()', () => {
      it('should transition OPEN → PARTIALLY_FILLED for partial fill', () => {
        const order = unwrap(createValidOrder({ status: 'OPEN' }));
        const fill = createFill({ size: Quantity.of(new Decimal('30')) });

        const result = order.applyFill(fill);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('PARTIALLY_FILLED');
          expect(result.value.fill.getFilledSize().value().toNumber()).toBe(30);
          expect(result.value.getRemainingSize().value().toNumber()).toBe(70);
        }
      });

      it('should transition OPEN → FILLED for complete fill', () => {
        const order = unwrap(createValidOrder({ status: 'OPEN' }));
        const fill = createFill({ size: Quantity.of(new Decimal('100')) });

        const result = order.applyFill(fill);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('FILLED');
          expect(result.value.fill.getFilledSize().value().toNumber()).toBe(100);
          expect(result.value.getRemainingSize().value().toNumber()).toBe(0);
        }
      });

      it('should accumulate multiple fills', () => {
        let order = unwrap(createValidOrder({ status: 'OPEN' }));

        // Fill 1: 30 units
        const fill1 = createFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('30')) });
        const result1 = order.applyFill(fill1);
        expect(result1.ok).toBe(true);
        order = unwrap(result1);
        expect(order.status).toBe('PARTIALLY_FILLED');
        expect(order.fill.getFilledSize().value().toNumber()).toBe(30);

        // Fill 2: 20 units
        const fill2 = createFill({ id: FILL_ID_2, size: Quantity.of(new Decimal('20')) });
        const result2 = order.applyFill(fill2);
        expect(result2.ok).toBe(true);
        order = unwrap(result2);
        expect(order.status).toBe('PARTIALLY_FILLED');
        expect(order.fill.getFilledSize().value().toNumber()).toBe(50);

        // Fill 3: 50 units (completes)
        const fill3 = createFill({ id: FILL_ID_3, size: Quantity.of(new Decimal('50')) });
        const result3 = order.applyFill(fill3);
        expect(result3.ok).toBe(true);
        order = unwrap(result3);
        expect(order.status).toBe('FILLED');
        expect(order.fill.getFilledSize().value().toNumber()).toBe(100);
      });

      it('should fail for duplicate fill ID', () => {
        let order = unwrap(createValidOrder({ status: 'OPEN' }));

        const fill1 = createFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('30')) });
        const result1 = order.applyFill(fill1);
        expect(result1.ok).toBe(true);
        order = unwrap(result1);

        // Try same fill ID again
        const fill2 = createFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('20')) });
        const result2 = order.applyFill(fill2);
        expect(result2.ok).toBe(false);
      });

      it('should fail if fill exceeds remaining size', () => {
        const order = unwrap(createValidOrder({ status: 'OPEN' }));
        const fill = createFill({ size: Quantity.of(new Decimal('150')) }); // Exceeds order size 100

        const result = order.applyFill(fill);
        expect(result.ok).toBe(false);
      });

      it('should fail for terminal status', () => {
        const order = unwrap(createValidOrder({ status: 'FILLED' }));
        const fill = createFill();

        const result = order.applyFill(fill);
        expect(result.ok).toBe(false);
      });
    });

    describe('canAcceptFill()', () => {
      it('should validate fill without applying it', () => {
        const order = unwrap(createValidOrder({ status: 'OPEN' }));
        const validFill = createFill({ size: Quantity.of(new Decimal('30')) });
        const invalidFill = createFill({ size: Quantity.of(new Decimal('150')) });

        expect(order.canAcceptFill(validFill)).toBe(true);
        expect(order.canAcceptFill(invalidFill)).toBe(false);
      });

      it('should reject fill with mismatched orderId', () => {
        const order = unwrap(createValidOrder({ status: 'OPEN' }));
        const fill = createFill({ orderId: asOrderId('wrong-order')! });

        expect(order.canAcceptFill(fill)).toBe(false);
      });

      it('should reject fill with mismatched side', () => {
        const order = unwrap(createValidOrder({ status: 'OPEN', side: 'BUY' }));
        const fill = createFill({ side: 'SELL' });

        expect(order.canAcceptFill(fill)).toBe(false);
      });

      it('should reject fill with mismatched asset', () => {
        const order = unwrap(createValidOrder({ status: 'OPEN' }));
        const otherAsset: AssetId = {
          ...TEST_ASSET,
          outcomeKey: parseOutcomeKey('NO')!,
        };
        const fill = createFill({ asset: otherAsset });

        expect(order.canAcceptFill(fill)).toBe(false);
      });

      it('should reject fill with zero size', () => {
        const order = unwrap(createValidOrder({ status: 'OPEN' }));
        const fill = createFill({ size: Quantity.of(new Decimal('0')) });

        expect(order.canAcceptFill(fill)).toBe(false);
      });

      it('should reject fill for PENDING status', () => {
        const order = unwrap(createValidOrder({ status: 'PENDING' }));
        const fill = createFill();

        expect(order.canAcceptFill(fill)).toBe(false);
      });

      it('should reject already-applied fill ID', () => {
        let order = unwrap(createValidOrder({ status: 'OPEN' }));

        // Apply fill first
        const fill = createFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('30')) });
        order = unwrap(order.applyFill(fill));

        // canAcceptFill must now reject the same fill ID
        expect(order.canAcceptFill(fill)).toBe(false);
      });

      it('canAcceptFill rejects exactly what applyFill rejects', () => {
        // Проверяем паритет: всё что canAcceptFill отклоняет — applyFill тоже отклоняет
        const order = unwrap(createValidOrder({ status: 'OPEN' }));

        const sizeTooLarge = createFill({ size: Quantity.of(new Decimal('150')) });
        expect(order.canAcceptFill(sizeTooLarge)).toBe(false);
        expect(order.applyFill(sizeTooLarge).ok).toBe(false);

        const wrongOrder = createFill({ orderId: asOrderId('other-order')! });
        expect(order.canAcceptFill(wrongOrder)).toBe(false);
        expect(order.applyFill(wrongOrder).ok).toBe(false);
      });

      describe('applyFill() валидация данных fill', () => {
        it('возвращает Err если asset fill не совпадает с asset заявки', () => {
          const order = unwrap(createValidOrder({ status: 'OPEN' }));
          const fill = createFill({
            asset: { ...TEST_ASSET, outcomeKey: parseOutcomeKey('NO')! },
          });
          const result = order.applyFill(fill);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.message).toContain('asset');
        });

        it('возвращает Err если side fill не совпадает с side заявки', () => {
          const order = unwrap(createValidOrder({ status: 'OPEN', side: 'BUY' }));
          const fill = createFill({ side: 'SELL' });
          const result = order.applyFill(fill);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.message).toContain('side');
        });

        it('возвращает Err если orderId fill не совпадает с id заявки', () => {
          const order = unwrap(createValidOrder({ status: 'OPEN' }));
          const fill = createFill({ orderId: asOrderId('other-order')! });
          const result = order.applyFill(fill);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.message).toContain('orderId');
        });
      });
    });
  });

  describe('immutability', () => {
    it('should return new instance on state changes', () => {
      const original = unwrap(createValidOrder({ status: 'PENDING' }));
      const result = original.accept();

      expect(result.ok).toBe(true);
      const accepted = unwrap(result);

      // Original should be unchanged
      expect(original.status).toBe('PENDING');

      // New instance should have new status
      expect(accepted.status).toBe('OPEN');

      // But same ID
      expect(accepted.id).toBe(original.id);
    });
  });

  describe('serialization', () => {
    it('toJSON() should serialize order', () => {
      const order = unwrap(createValidOrder({
        id: ORDER_ID,
        status: 'OPEN',
      }));

      const json = order.toJSON();

      expect(json.id).toBe(ORDER_ID);
      expect(json.status).toBe('OPEN');
      expect(json.price).toBe(0.65);
      expect(json.size).toBe(100);
      expect(json.notional).toBe(65);
      expect(json.remainingSize).toBe(100);
      expect(json.fillPercentage).toBe(0);
    });

    it('toString() should provide readable representation', () => {
      const order = unwrap(createValidOrder({
        id: ORDER_ID,
        side: 'BUY',
        size: Quantity.of(new Decimal('100')),
        price: Price.of(new Decimal('0.65')),
        status: 'OPEN',
      }));

      const str = order.toString();

      expect(str).toContain('order-123');
      expect(str).toContain('BUY');
      expect(str).toContain('100');
      expect(str).toContain('0.65');
      expect(str).toContain('OPEN');
    });
  });
});

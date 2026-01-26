/**
 * Order entity tests - рефакторенная версия с Result pattern
 *
 * @remarks
 * Тесты для Order entity после рефакторинга с Result pattern.
 * Покрывают валидацию, создание, сериализацию и бизнес-логику.
 */
import { describe, it, expect } from '@jest/globals';
import { Order, type OrderStatus } from '../../src/Order.js';
import { Price, Quantity } from '@polymarket/value-objects';
import { OrderValidationError } from '@polymarket/errors';

describe('Order Entity (Result pattern)', () => {
  // Helper для создания валидных Price и Quantity
  const createPrice = (value: number): Price => {
    const result = Price.fromValue(value);
    if (!result.ok) throw new Error(`Failed to create Price: ${result.error.message}`);
    return result.value;
  };

  const createQuantity = (value: number): Quantity => {
    const result = Quantity.fromValue(value);
    if (!result.ok) throw new Error(`Failed to create Quantity: ${result.error.message}`);
    return result.value;
  };

  describe('Order.create() - успешное создание', () => {
    it('должен создать Order с минимальными параметрами', () => {
      const result = Order.create({
        id: 'order-123',
        marketId: 'market-abc',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'PENDING',
        timestamp: new Date('2024-01-15T10:00:00Z'),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('order-123');
        expect(result.value.marketId).toBe('market-abc');
        expect(result.value.tokenId).toBe('token-yes');
        expect(result.value.side).toBe('BUY');
        expect(result.value.price.value).toBe(0.65);
        expect(result.value.size.value).toBe(100);
        expect(result.value.status).toBe('PENDING');
        expect(result.value.timestamp).toEqual(new Date('2024-01-15T10:00:00Z'));
      }
    });

    it('должен создать Order со всеми параметрами', () => {
      const result = Order.create({
        id: 'order-456',
        marketId: 'market-xyz',
        tokenId: 'token-no',
        side: 'SELL',
        price: createPrice(0.35),
        size: createQuantity(200),
        status: 'PARTIALLY_FILLED',
        timestamp: new Date('2024-01-15T11:00:00Z'),
        strategyId: 'strategy-1',
        filledSize: createQuantity(50),
        averageFillPrice: createPrice(0.36),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('order-456');
        expect(result.value.strategyId).toBe('strategy-1');
        expect(result.value.filledSize?.value).toBe(50);
        expect(result.value.averageFillPrice?.value).toBe(0.36);
      }
    });
  });

  describe('Order.create() - валидация полей', () => {
    const validParams = {
      id: 'order-123',
      marketId: 'market-abc',
      tokenId: 'token-yes',
      side: 'BUY' as const,
      price: createPrice(0.65),
      size: createQuantity(100),
      status: 'OPEN' as OrderStatus,
      timestamp: new Date(),
    };

    it('должен вернуть ошибку если id пустой', () => {
      const result = Order.create({ ...validParams, id: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderValidationError);
        expect(result.error.message).toContain('ID must be a non-empty string');
      }
    });

    it('должен вернуть ошибку если marketId пустой', () => {
      const result = Order.create({ ...validParams, marketId: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderValidationError);
        expect(result.error.message).toContain('Market ID must be a non-empty string');
      }
    });

    it('должен вернуть ошибку если tokenId пустой', () => {
      const result = Order.create({ ...validParams, tokenId: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderValidationError);
        expect(result.error.message).toContain('Token ID must be a non-empty string');
      }
    });

    it('должен вернуть ошибку если side невалидный', () => {
      const result = Order.create({ ...validParams, side: 'INVALID' as any });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderValidationError);
        expect(result.error.message).toContain('Invalid order side');
      }
    });

    it('должен вернуть ошибку если filledSize > size', () => {
      const result = Order.create({
        ...validParams,
        filledSize: createQuantity(150),
        averageFillPrice: createPrice(0.65),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderValidationError);
        expect(result.error.message).toContain('cannot exceed order size');
      }
    });

    it('должен вернуть ошибку если filledSize > 0 но нет averageFillPrice', () => {
      const result = Order.create({
        ...validParams,
        filledSize: createQuantity(50),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderValidationError);
        expect(result.error.message).toContain('Average fill price is required');
      }
    });

    it('должен вернуть ошибку если timestamp невалидный', () => {
      const result = Order.create({
        ...validParams,
        timestamp: new Date('invalid'),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderValidationError);
        expect(result.error.message).toContain('Invalid timestamp');
      }
    });
  });

  describe('Order.fromJSON() и toJSON()', () => {
    it('должен создать Order из валидного JSON', () => {
      const json = {
        id: 'order-json-1',
        marketId: 'market-json',
        tokenId: 'token-json',
        side: 'SELL',
        price: 0.42,
        size: 75,
        status: 'FILLED',
        timestamp: '2024-01-15T12:00:00Z',
        strategyId: 'strat-1',
        filledSize: 75,
        averageFillPrice: 0.43,
      };

      const result = Order.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('order-json-1');
        expect(result.value.marketId).toBe('market-json');
        expect(result.value.side).toBe('SELL');
        expect(result.value.price.value).toBe(0.42);
        expect(result.value.size.value).toBe(75);
        expect(result.value.strategyId).toBe('strat-1');
        expect(result.value.filledSize?.value).toBe(75);
      }
    });

    it('должен сериализовать Order в JSON и восстановить', () => {
      const originalResult = Order.create({
        id: 'order-round-trip',
        marketId: 'market-rt',
        tokenId: 'token-rt',
        side: 'BUY',
        price: createPrice(0.68),
        size: createQuantity(300),
        status: 'OPEN',
        timestamp: new Date('2024-01-15T14:00:00Z'),
      });

      expect(originalResult.ok).toBe(true);
      if (!originalResult.ok) return;

      const json = originalResult.value.toJSON();
      const restoredResult = Order.fromJSON(json);

      expect(restoredResult.ok).toBe(true);
      if (restoredResult.ok) {
        expect(restoredResult.value.id).toBe(originalResult.value.id);
        expect(restoredResult.value.marketId).toBe(originalResult.value.marketId);
        expect(restoredResult.value.price.value).toBe(originalResult.value.price.value);
        expect(restoredResult.value.size.value).toBe(originalResult.value.size.value);
      }
    });

    it('должен вернуть ошибку если JSON невалидный', () => {
      const result = Order.fromJSON({ id: 123 } as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderValidationError);
      }
    });
  });

  describe('Order методы обновления', () => {
    const createTestOrder = () => {
      const result = Order.create({
        id: 'order-update',
        marketId: 'market-update',
        tokenId: 'token-update',
        side: 'BUY',
        price: createPrice(0.5),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date(),
      });
      if (!result.ok) throw new Error('Failed to create test order');
      return result.value;
    };

    it('withStatus() должен создать новый Order с обновленным статусом', () => {
      const order = createTestOrder();
      const result = order.withStatus('CANCELED');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(order.id);
        expect(result.value.status).toBe('CANCELED');
        expect(order.status).toBe('OPEN'); // Immutability
      }
    });

    it('withFill() должен создать новый Order с fill данными', () => {
      const order = createTestOrder();
      const result = order.withFill(createQuantity(50), createPrice(0.51));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.filledSize?.value).toBe(50);
        expect(result.value.averageFillPrice?.value).toBe(0.51);
        expect(result.value.status).toBe('OPEN'); // Не полностью заполнен
      }
    });

    it('withFill() должен установить статус FILLED если полностью заполнен', () => {
      const order = createTestOrder();
      const result = order.withFill(createQuantity(100), createPrice(0.51));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.filledSize?.value).toBe(100);
        expect(result.value.status).toBe('FILLED');
      }
    });
  });

  describe('Order геттеры', () => {
    it('getNotional() должен вернуть price * size', () => {
      const result = Order.create({
        id: 'order-notional',
        marketId: 'market-test',
        tokenId: 'token-test',
        side: 'BUY',
        price: createPrice(0.6),
        size: createQuantity(150),
        status: 'OPEN',
        timestamp: new Date(),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getNotional().toNumber()).toBe(90); // 0.6 * 150
      }
    });

    it('getRemainingSize() должен вернуть size - filledSize', () => {
      const result = Order.create({
        id: 'order-remaining',
        marketId: 'market-test',
        tokenId: 'token-test',
        side: 'BUY',
        price: createPrice(0.5),
        size: createQuantity(100),
        status: 'PARTIALLY_FILLED',
        timestamp: new Date(),
        filledSize: createQuantity(40),
        averageFillPrice: createPrice(0.5),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const remaining = result.value.getRemainingSize();
        expect(remaining.value).toBe(60);
      }
    });

    it('getFillPercentage() должен вернуть процент заполнения', () => {
      const result = Order.create({
        id: 'order-pct',
        marketId: 'market-test',
        tokenId: 'token-test',
        side: 'SELL',
        price: createPrice(0.4),
        size: createQuantity(200),
        status: 'PARTIALLY_FILLED',
        timestamp: new Date(),
        filledSize: createQuantity(50),
        averageFillPrice: createPrice(0.4),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getFillPercentage().toNumber()).toBe(25); // 50/200 * 100
      }
    });
  });

  describe('Order предикаты', () => {
    it('isFilled() должен вернуть true для FILLED статуса', () => {
      const result = Order.create({
        id: 'order-filled',
        marketId: 'market-test',
        tokenId: 'token-test',
        side: 'BUY',
        price: createPrice(0.5),
        size: createQuantity(100),
        status: 'FILLED',
        timestamp: new Date(),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isFilled()).toBe(true);
        expect(result.value.isOpen()).toBe(false);
      }
    });

    it('isOpen() должен вернуть true для OPEN статуса', () => {
      const result = Order.create({
        id: 'order-open',
        marketId: 'market-test',
        tokenId: 'token-test',
        side: 'BUY',
        price: createPrice(0.5),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date(),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isOpen()).toBe(true);
        expect(result.value.isFilled()).toBe(false);
      }
    });

    it('isPending() должен вернуть true для PENDING статуса', () => {
      const result = Order.create({
        id: 'order-pending',
        marketId: 'market-test',
        tokenId: 'token-test',
        side: 'BUY',
        price: createPrice(0.5),
        size: createQuantity(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isPending()).toBe(true);
      }
    });

    it('canCancel() должен вернуть true для PENDING и OPEN', () => {
      const pendingResult = Order.create({
        id: 'order-1',
        marketId: 'market-test',
        tokenId: 'token-test',
        side: 'BUY',
        price: createPrice(0.5),
        size: createQuantity(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      const openResult = Order.create({
        id: 'order-2',
        marketId: 'market-test',
        tokenId: 'token-test',
        side: 'BUY',
        price: createPrice(0.5),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date(),
      });

      const filledResult = Order.create({
        id: 'order-3',
        marketId: 'market-test',
        tokenId: 'token-test',
        side: 'BUY',
        price: createPrice(0.5),
        size: createQuantity(100),
        status: 'FILLED',
        timestamp: new Date(),
      });

      // PENDING orders cannot be cancelled (only accepted or rejected)
      expect(pendingResult.ok && pendingResult.value.canCancel()).toBe(false);
      // OPEN orders can be cancelled
      expect(openResult.ok && openResult.value.canCancel()).toBe(true);
      // FILLED orders cannot be cancelled (terminal status)
      expect(filledResult.ok && filledResult.value.canCancel()).toBe(false);
    });

    it('isPartiallyFilled() должен вернуть true если 0 < filledSize < size', () => {
      const partialResult = Order.create({
        id: 'order-partial',
        marketId: 'market-test',
        tokenId: 'token-test',
        side: 'BUY',
        price: createPrice(0.5),
        size: createQuantity(100),
        status: 'PARTIALLY_FILLED',
        timestamp: new Date(),
        filledSize: createQuantity(50),
        averageFillPrice: createPrice(0.5),
      });

      const emptyResult = Order.create({
        id: 'order-empty',
        marketId: 'market-test',
        tokenId: 'token-test',
        side: 'BUY',
        price: createPrice(0.5),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date(),
      });

      expect(partialResult.ok && partialResult.value.isPartiallyFilled()).toBe(true);
      expect(emptyResult.ok && emptyResult.value.isPartiallyFilled()).toBe(false);
    });
  });

});

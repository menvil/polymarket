/**
 * Integration tests for ExecutionService
 *
 * @remarks
 * Tests full execution pipeline coordination:
 * Order Intent → Normalize → Validate → Execute → Result
 *
 * Uses real implementations where possible, mocks only external dependencies (HTTP, IO).
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ExecutionService } from '../../../src/application/execution/ExecutionService.js';
import { IntentNormalizer } from '../../../src/application/execution/IntentNormalizer.js';
import { ValidationPipeline } from '../../../src/application/execution/ValidationPipeline.js';
import { ValidationContextProvider } from '../../../src/application/execution/ValidationContextProvider.js';
import type { ITradingGateway } from '../../../src/domain/ports/ITradingGateway.js';
import type { PlaceOrderResult, CancelOrderResult, GetOrdersResult } from '../../../src/domain/types/ExecutionResult.js';
import type { IBalanceProvider, IPositionProvider } from '../../../src/application/execution/ValidationContextProvider.js';
import type { MarketConstraints } from '../../../src/infrastructure/exchange/policies/types.js';
import { Order } from '../../../src/domain/entities/Order.js';
import { Price } from '../../../src/domain/value-objects/Price.js';
import { Quantity } from '../../../src/domain/value-objects/Quantity.js';
import { Ok, Err } from '../../../src/shared/types/Result.js';
import { ValidationErrorCode } from '../../../src/domain/types/ValidationError.js';
import { ExchangeErrorCode } from '../../../src/domain/types/ExchangeError.js';
import { MockLogger } from '../../helpers/MockLogger.js';

/**
 * Mock implementations for dependencies
 */

class MockMarketConstraintsPolicy {
  constructor(private constraints?: Partial<MarketConstraints>) {}

  async getConstraints(_tokenId: string): Promise<MarketConstraints> {
    return {
      minOrderSize: 10,
      maxOrderSize: 1000,
      sizeTick: 0.01,
      timestamp: Date.now(),
      ...this.constraints,
    };
  }

  setConstraints(constraints: Partial<MarketConstraints>): void {
    this.constraints = { ...this.constraints, ...constraints };
  }
}

class MockBalanceProvider implements IBalanceProvider {
  constructor(private balance: number = 1000) {}

  async getAvailableBalance(): Promise<number> {
    return this.balance;
  }

  setBalance(balance: number): void {
    this.balance = balance;
  }
}

class MockPositionProvider implements IPositionProvider {
  constructor(
    private currentPosition: number = 0,
    private positionLimit: number = 5000
  ) {}

  async getPositionState(_tokenId: string): Promise<{
    currentPosition: number;
    positionLimit: number;
    unrealizedPnl?: number;
  }> {
    return {
      currentPosition: this.currentPosition,
      positionLimit: this.positionLimit,
    };
  }

  setPosition(position: number): void {
    this.currentPosition = position;
  }
}

class MockTradingGateway implements ITradingGateway {
  public placeOrderFn = jest.fn<(order: Order) => Promise<PlaceOrderResult>>();
  public cancelOrderFn = jest.fn<(orderId: string) => Promise<CancelOrderResult>>();
  public getOpenOrdersFn = jest.fn<(tokenId?: string) => Promise<GetOrdersResult>>();

  async placeOrder(order: Order): Promise<PlaceOrderResult> {
    return this.placeOrderFn(order);
  }

  async cancelOrder(orderId: string): Promise<CancelOrderResult> {
    return this.cancelOrderFn(orderId);
  }

  async getOpenOrders(tokenId?: string): Promise<GetOrdersResult> {
    return this.getOpenOrdersFn(tokenId);
  }
}

describe('ExecutionService (Integration)', () => {
  let executionService: ExecutionService;
  let normalizer: IntentNormalizer;
  let validationPipeline: ValidationPipeline;
  let contextProvider: ValidationContextProvider;
  let mockGateway: MockTradingGateway;
  let mockBalanceProvider: MockBalanceProvider;
  let mockPositionProvider: MockPositionProvider;
  let mockMarketPolicy: MockMarketConstraintsPolicy;
  let logger: MockLogger;

  beforeEach(() => {
    logger = new MockLogger();
    normalizer = new IntentNormalizer();
    validationPipeline = new ValidationPipeline(logger);

    mockBalanceProvider = new MockBalanceProvider(1000);
    mockPositionProvider = new MockPositionProvider(0, 5000);
    mockMarketPolicy = new MockMarketConstraintsPolicy();

    contextProvider = new ValidationContextProvider(
      mockMarketPolicy as any, // Mock implementation
      mockBalanceProvider,
      mockPositionProvider,
      logger
    );

    mockGateway = new MockTradingGateway();

    executionService = new ExecutionService(
      normalizer,
      validationPipeline,
      contextProvider,
      mockGateway,
      logger
    );
  });

  describe('placeOrder() - successful flow', () => {
    it('should execute full pipeline for valid order', async () => {
      const orderIntent = Order.create({
        id: 'test-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.567), // Will be normalized to 0.57
        size: Quantity.fromNumber(100.123), // Will be normalized to 100.12
        status: 'PENDING',
        timestamp: new Date(),
      });

      // Mock gateway to return success
      const placedOrder = Order.create({
        id: 'exchange-123',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.57),
        size: Quantity.fromNumber(100.12),
        status: 'OPEN',
        timestamp: new Date(),
      });

      mockGateway.placeOrderFn.mockResolvedValue(Ok(placedOrder));

      const result = await executionService.placeOrder(orderIntent);

      // Should succeed
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('exchange-123');
        expect(result.value.status).toBe('OPEN');
        expect(result.value.price.value).toBe(0.57); // Normalized
        expect(result.value.size.value).toBe(100.12); // Normalized
      }

      // Should call gateway with normalized order
      expect(mockGateway.placeOrderFn).toHaveBeenCalledTimes(1);
      const calledOrder = mockGateway.placeOrderFn.mock.calls[0][0] as Order;
      expect(calledOrder.price.value).toBe(0.57);
      expect(calledOrder.size.value).toBe(100.12);

      // Should log normalization
      const normalizationLogs = logger.infoCalls.filter(call =>
        call.message.includes('normalized')
      );
      expect(normalizationLogs.length).toBeGreaterThan(0);
    });

    it('should skip normalization if order already normalized', async () => {
      const orderIntent = Order.create({
        id: 'test-2',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5), // Already aligned
        size: Quantity.fromNumber(100.0), // Already aligned
        status: 'PENDING',
        timestamp: new Date(),
      });

      const placedOrder = Order.create({
        ...orderIntent,
        id: 'exchange-456',
        status: 'OPEN',
      });

      mockGateway.placeOrderFn.mockResolvedValue(Ok(placedOrder));

      const result = await executionService.placeOrder(orderIntent);

      expect(result.ok).toBe(true);

      // Should NOT log normalization (wasNormalized = false)
      const normalizationLogs = logger.infoCalls.filter(call =>
        call.message.includes('normalized')
      );
      expect(normalizationLogs.length).toBe(0);
    });
  });

  describe('placeOrder() - validation failures (REJECTED)', () => {
    it('should reject order below minOrderSize', async () => {
      const orderIntent = Order.create({
        id: 'test-3',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(5), // Below min (10)
        status: 'PENDING',
        timestamp: new Date(),
      });

      const result = await executionService.placeOrder(orderIntent);

      // Should be REJECTED
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('REJECTED');
        expect(result.error.error.type).toBe('INVALID_SIZE');
        expect(result.error.error.code).toBe(ValidationErrorCode.INVALID_SIZE);
      }

      // Should NOT call gateway (failed validation)
      expect(mockGateway.placeOrderFn).not.toHaveBeenCalled();

      // Should log validation failure
      const validationLogs = logger.warnCalls.filter(call =>
        call.message.includes('validation failed')
      );
      expect(validationLogs.length).toBeGreaterThan(0);
    });

    it('should reject order with insufficient balance', async () => {
      const orderIntent = Order.create({
        id: 'test-4',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(100), // Required: $50
        status: 'PENDING',
        timestamp: new Date(),
      });

      // Set balance to insufficient amount
      mockBalanceProvider.setBalance(40); // Only $40

      const result = await executionService.placeOrder(orderIntent);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('REJECTED');
        expect(result.error.error.type).toBe('INSUFFICIENT_BALANCE');
        if (result.error.error.type === 'INSUFFICIENT_BALANCE') {
          expect(result.error.error.required).toBe(50);
          expect(result.error.error.available).toBe(40);
        }
      }

      expect(mockGateway.placeOrderFn).not.toHaveBeenCalled();
    });

    it('should reject order exceeding position limit', async () => {
      // Allow large orders (maxOrderSize = 10000) to test position limit
      mockMarketPolicy.setConstraints({ maxOrderSize: 10000 });

      const orderIntent = Order.create({
        id: 'test-5',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(6000), // Would exceed limit (5000)
        status: 'PENDING',
        timestamp: new Date(),
      });

      // Set sufficient balance but position would exceed limit
      mockBalanceProvider.setBalance(10000);
      mockPositionProvider.setPosition(0);

      const result = await executionService.placeOrder(orderIntent);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('REJECTED');
        expect(result.error.error.type).toBe('POSITION_LIMIT_EXCEEDED');
      }

      expect(mockGateway.placeOrderFn).not.toHaveBeenCalled();
    });
  });

  describe('placeOrder() - exchange failures (FAILED)', () => {
    it('should return FAILED when gateway returns ExchangeError', async () => {
      const orderIntent = Order.create({
        id: 'test-6',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      // Mock gateway to return RATE_LIMITED error
      mockGateway.placeOrderFn.mockResolvedValue(
        Err({
          kind: 'FAILED',
          error: {
            type: 'RATE_LIMITED',
            code: ExchangeErrorCode.RATE_LIMITED,
            retryAfter: 60,
            message: 'Too many requests',
          },
        })
      );

      const result = await executionService.placeOrder(orderIntent);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('FAILED');
        expect(result.error.error.type).toBe('RATE_LIMITED');
        if (result.error.error.type === 'RATE_LIMITED') {
          expect(result.error.error.retryAfter).toBe(60);
        }
      }

      // Should call gateway (validation passed)
      expect(mockGateway.placeOrderFn).toHaveBeenCalledTimes(1);

      // Should log exchange error
      const errorLogs = logger.errorCalls.filter(call =>
        call.message.includes('placement failed')
      );
      expect(errorLogs.length).toBeGreaterThan(0);
    });

    it('should handle MARKET_CLOSED error', async () => {
      const orderIntent = Order.create({
        id: 'test-7',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      mockGateway.placeOrderFn.mockResolvedValue(
        Err({
          kind: 'FAILED',
          error: {
            type: 'MARKET_CLOSED',
            code: ExchangeErrorCode.MARKET_CLOSED,
            marketId: 'test-market',
            reason: 'Market is closed',
          },
        })
      );

      const result = await executionService.placeOrder(orderIntent);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('FAILED');
        expect(result.error.error.type).toBe('MARKET_CLOSED');
      }
    });

    it('should handle FATAL error', async () => {
      const orderIntent = Order.create({
        id: 'test-8',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      mockGateway.placeOrderFn.mockResolvedValue(
        Err({
          kind: 'FAILED',
          error: {
            type: 'FATAL',
            code: ExchangeErrorCode.FATAL,
            httpStatus: 418,
            message: 'I am a teapot',
            requiresManualInvestigation: true,
          },
        })
      );

      const result = await executionService.placeOrder(orderIntent);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('FAILED');
        expect(result.error.error.type).toBe('FATAL');
        if (result.error.error.type === 'FATAL') {
          expect(result.error.error.requiresManualInvestigation).toBe(true);
        }
      }
    });
  });

  describe('placeOrder() - error handling', () => {
    it('should handle unexpected error in pipeline', async () => {
      const orderIntent = Order.create({
        id: 'test-9',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      // Mock gateway to throw unexpected error
      mockGateway.placeOrderFn.mockRejectedValue(new Error('Unexpected network error'));

      const result = await executionService.placeOrder(orderIntent);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('FAILED');
        expect(result.error.error.type).toBe('FATAL');
        if (result.error.error.type === 'FATAL') {
          expect(result.error.error.message).toContain('Unexpected network error');
        }
      }
    });
  });

  describe('cancelOrder()', () => {
    it('should pass-through to gateway', async () => {
      mockGateway.cancelOrderFn.mockResolvedValue(Ok(undefined));

      const result = await executionService.cancelOrder('order-123');

      expect(result.ok).toBe(true);
      expect(mockGateway.cancelOrderFn).toHaveBeenCalledWith('order-123');
    });

    it('should return gateway error', async () => {
      mockGateway.cancelOrderFn.mockResolvedValue(
        Err({
          kind: 'FAILED',
          error: {
            type: 'ORDER_NOT_FOUND',
            code: ExchangeErrorCode.ORDER_NOT_FOUND,
            orderId: 'order-123',
          },
        })
      );

      const result = await executionService.cancelOrder('order-123');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error.type).toBe('ORDER_NOT_FOUND');
      }
    });
  });

  describe('getOpenOrders()', () => {
    it('should pass-through to gateway', async () => {
      const orders = [
        Order.create({
          id: 'order-1',
          tokenId: 'token-yes',
          side: 'BUY',
          price: Price.fromNumber(0.5),
          size: Quantity.fromNumber(100),
          status: 'OPEN',
          timestamp: new Date(),
        }),
      ];

      mockGateway.getOpenOrdersFn.mockResolvedValue(Ok(orders));

      const result = await executionService.getOpenOrders('token-yes');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(orders);
      }
      expect(mockGateway.getOpenOrdersFn).toHaveBeenCalledWith('token-yes');
    });

    it('should handle gateway error', async () => {
      mockGateway.getOpenOrdersFn.mockResolvedValue(
        Err({
          kind: 'FAILED',
          error: {
            type: 'SERVER_ERROR',
            code: ExchangeErrorCode.SERVER_ERROR,
            status: 500,
            message: 'Internal server error',
          },
        })
      );

      const result = await executionService.getOpenOrders();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error.type).toBe('SERVER_ERROR');
      }
    });
  });
});

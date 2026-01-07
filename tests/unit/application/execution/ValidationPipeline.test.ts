/**
 * Unit tests for ValidationPipeline
 *
 * @remarks
 * Tests pure function validation logic WITHOUT IO.
 * ValidationPipeline receives ValidationContext as parameter (no HTTP, no async state).
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ValidationPipeline } from '../../../../src/application/execution/ValidationPipeline.js';
import { Order } from '../../../../src/domain/entities/Order.js';
import { Price } from '../../../../src/domain/value-objects/Price.js';
import { Quantity } from '../../../../src/domain/value-objects/Quantity.js';
import type { ValidationContext } from '../../../../src/domain/types/ValidationContext.js';
import { ValidationErrorCode } from '../../../../src/domain/types/ValidationError.js';
import { MockLogger } from '../../../helpers/MockLogger.js';

describe('ValidationPipeline', () => {
  let pipeline: ValidationPipeline;
  let logger: MockLogger;

  // Default ValidationContext for tests
  const createDefaultContext = (): ValidationContext => ({
    balance: 1000, // $1000 USDC available
    marketConstraints: {
      minOrderSize: 10,
      maxOrderSize: 1000,
      sizeTick: 0.01,
      priceTick: 0.01,
      minPrice: 0.01,
      maxPrice: 0.99,
    },
    positionState: {
      currentPosition: 0,
      positionLimit: 5000,
    },
    timestamp: new Date('2024-01-01T00:00:00Z'),
  });

  beforeEach(() => {
    logger = new MockLogger();
    pipeline = new ValidationPipeline(logger);
  });

  describe('validate() - size constraints', () => {
    it('should reject order below minOrderSize', () => {
      const order = Order.create({
        id: 'test-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(5), // Below minOrderSize (10)
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('INVALID_SIZE');
        expect(result.error.code).toBe(ValidationErrorCode.INVALID_SIZE);
        if (result.error.type === 'INVALID_SIZE') {
          expect(result.error.min).toBe(10);
          expect(result.error.max).toBe(1000);
          expect(result.error.provided).toBe(5);
        }
      }
    });

    it('should reject order above maxOrderSize', () => {
      const order = Order.create({
        id: 'test-2',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(1500), // Above maxOrderSize (1000)
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('INVALID_SIZE');
        if (result.error.type === 'INVALID_SIZE') {
          expect(result.error.provided).toBe(1500);
        }
      }
    });

    it('should accept order at minOrderSize boundary', () => {
      const order = Order.create({
        id: 'test-3',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(10), // Exactly minOrderSize
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(true);
    });

    it('should accept order at maxOrderSize boundary', () => {
      const order = Order.create({
        id: 'test-4',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(1000), // Exactly maxOrderSize
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      context.balance = 5000; // Enough balance for 1000 @ 0.5 = $500
      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(true);
    });
  });

  describe('validate() - price constraints', () => {
    it('should reject order below minPrice', () => {
      const order = Order.create({
        id: 'test-5',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.005), // Below minPrice (0.01)
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('INVALID_PRICE');
        expect(result.error.code).toBe(ValidationErrorCode.INVALID_PRICE);
        if (result.error.type === 'INVALID_PRICE') {
          expect(result.error.min).toBe(0.01);
          expect(result.error.max).toBe(0.99);
          expect(result.error.provided).toBe(0.005);
        }
      }
    });

    it('should reject order above maxPrice', () => {
      // Create order with maxPrice + small amount (0.995)
      // Price.fromNumber validates 0.01-0.99, so we need to use context with different maxPrice
      const context = createDefaultContext();
      context.marketConstraints.maxPrice = 0.9; // Set max to 0.9

      const order = Order.create({
        id: 'test-6',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.95), // Above maxPrice (0.9)
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('INVALID_PRICE');
        if (result.error.type === 'INVALID_PRICE') {
          expect(result.error.provided).toBe(0.95);
        }
      }
    });

    it('should accept order at minPrice boundary', () => {
      const order = Order.create({
        id: 'test-7',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.01), // Exactly minPrice
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(true);
    });

    it('should accept order at maxPrice boundary', () => {
      const order = Order.create({
        id: 'test-8',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.99), // Exactly maxPrice
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      context.balance = 1000; // Enough for 100 @ 0.99 = $99
      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(true);
    });
  });

  describe('validate() - balance constraints', () => {
    it('should reject BUY order with insufficient USDC balance', () => {
      const order = Order.create({
        id: 'test-9',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(100), // Required: 100 * 0.5 = $50
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      context.balance = 40; // Insufficient balance ($40 < $50)

      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('INSUFFICIENT_BALANCE');
        expect(result.error.code).toBe(ValidationErrorCode.INSUFFICIENT_BALANCE);
        if (result.error.type === 'INSUFFICIENT_BALANCE') {
          expect(result.error.required).toBe(50);
          expect(result.error.available).toBe(40);
          expect(result.error.asset).toBe('USDC');
        }
      }
    });

    it('should accept BUY order with exact balance', () => {
      const order = Order.create({
        id: 'test-10',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(100), // Required: $50
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      context.balance = 50; // Exactly $50

      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(true);
    });

    it('should accept BUY order with surplus balance', () => {
      const order = Order.create({
        id: 'test-11',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(100), // Required: $50
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      context.balance = 1000; // Surplus balance

      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(true);
    });

    it('should skip balance check for SELL orders (not implemented yet)', () => {
      const order = Order.create({
        id: 'test-12',
        tokenId: 'token-yes',
        side: 'SELL',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      context.balance = 0; // No USDC (but SELL doesn't need USDC)

      const result = pipeline.validate(order, context);

      // Should pass (SELL balance check not implemented yet)
      expect(result.ok).toBe(true);
    });
  });

  describe('validate() - position limits', () => {
    it('should reject order that exceeds position limit', () => {
      const order = Order.create({
        id: 'test-13',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(6000), // Would create position of 6000
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      context.positionState.currentPosition = 0;
      context.positionState.positionLimit = 5000; // Limit is 5000
      context.balance = 10000; // Enough balance
      context.marketConstraints.maxOrderSize = 10000; // Allow large order

      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('POSITION_LIMIT_EXCEEDED');
        expect(result.error.code).toBe(ValidationErrorCode.POSITION_LIMIT_EXCEEDED);
        if (result.error.type === 'POSITION_LIMIT_EXCEEDED') {
          expect(result.error.current).toBe(0);
          expect(result.error.limit).toBe(5000);
        }
      }
    });

    it('should accept order that adds to existing position within limit', () => {
      const order = Order.create({
        id: 'test-14',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(1000), // Would create position of 3000
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      context.positionState.currentPosition = 2000; // Already have 2000
      context.positionState.positionLimit = 5000; // Limit is 5000
      context.balance = 10000; // Enough balance

      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(true);
    });

    it('should accept order at exact position limit', () => {
      const order = Order.create({
        id: 'test-15',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(3000), // Would create position of exactly 5000
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      context.positionState.currentPosition = 2000;
      context.positionState.positionLimit = 5000;
      context.balance = 10000;
      context.marketConstraints.maxOrderSize = 10000;

      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(true);
    });

    it('should handle SELL order reducing position', () => {
      const order = Order.create({
        id: 'test-16',
        tokenId: 'token-yes',
        side: 'SELL',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(1000), // Reduces position to 1000
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      context.positionState.currentPosition = 2000; // Currently 2000
      context.positionState.positionLimit = 5000;

      const result = pipeline.validate(order, context);

      // Should pass (reducing position)
      expect(result.ok).toBe(true);
    });

    it('should handle negative positions (short)', () => {
      const order = Order.create({
        id: 'test-17',
        tokenId: 'token-yes',
        side: 'SELL',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(6000), // Would create -4000 position
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();
      context.positionState.currentPosition = 2000; // Currently long 2000
      context.positionState.positionLimit = 3000; // Limit is 3000
      context.marketConstraints.maxOrderSize = 10000;

      const result = pipeline.validate(order, context);

      // Should fail (abs(-4000) > 3000 limit)
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('POSITION_LIMIT_EXCEEDED');
      }
    });
  });

  describe('validate() - integration (all checks)', () => {
    it('should pass all validations for valid order', () => {
      const order = Order.create({
        id: 'test-18',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();

      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(true);
      expect(logger.debugCalls.length).toBeGreaterThan(0); // Should log success
    });

    it('should fail on first validation error (size)', () => {
      const order = Order.create({
        id: 'test-19',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(5), // Invalid size (< min)
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context = createDefaultContext();

      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('INVALID_SIZE');
      }
      expect(logger.warnCalls.length).toBeGreaterThan(0); // Should log warning
    });

    it('should fail on price validation before balance check', () => {
      const context = createDefaultContext();
      context.marketConstraints.maxPrice = 0.5; // Set lower max price

      const order = Order.create({
        id: 'test-20',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.6), // Invalid price (> 0.5 max)
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      const result = pipeline.validate(order, context);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Should fail on price, not reach balance check
        expect(result.error.type).toBe('INVALID_PRICE');
      }
    });
  });

  describe('validate() - determinism', () => {
    it('should be deterministic (same input → same output)', () => {
      const order = Order.create({
        id: 'test-21',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date('2024-01-01T00:00:00Z'),
      });

      const context = createDefaultContext();

      // Run validation 3 times
      const result1 = pipeline.validate(order, context);
      const result2 = pipeline.validate(order, context);
      const result3 = pipeline.validate(order, context);

      // All results should be identical
      expect(result1.ok).toBe(result2.ok);
      expect(result1.ok).toBe(result3.ok);
    });

    it('should produce same result for same context snapshot', () => {
      const order = Order.create({
        id: 'test-22',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      const context1 = createDefaultContext();
      const context2 = createDefaultContext();

      const result1 = pipeline.validate(order, context1);
      const result2 = pipeline.validate(order, context2);

      // Same context snapshot → same result
      expect(result1.ok).toBe(result2.ok);
    });
  });
});

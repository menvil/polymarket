/**
 * Trade entity unit tests
 *
 * @remarks
 * Тестирует создание, валидацию, fromPolymarketEvent и сериализацию Trade entity.
 */

import { describe, it, expect } from '@jest/globals';
import { Trade } from '../../src/Trade';
import { Price, Quantity } from '@polymarket/value-objects';

describe('Trade entity', () => {
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

  // Валидные параметры для тестов
  const validParams = {
    id: 'trade-1',
    marketId: 'market-123',
    tokenId: 'token-yes-456',
    price: createPrice(0.65),
    size: createQuantity(100),
    side: 'BUY' as const,
    timestamp: new Date('2024-01-15T10:30:00.000Z'),
    transactionHash: '0x1234abcd...',
    orderId: 'order-1'
  };

  describe('create() factory method', () => {
    it('should create valid trade with Result<Ok>', () => {
      const result = Trade.create(validParams);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('trade-1');
        expect(result.value.marketId).toBe('market-123');
        expect(result.value.tokenId).toBe('token-yes-456');
        expect(result.value.price.value).toBe(0.65);
        expect(result.value.size.value).toBe(100);
        expect(result.value.side).toBe('BUY');
        expect(result.value.transactionHash).toBe('0x1234abcd...');
        expect(result.value.orderId).toBe('order-1');
      }
    });

    it('should create trade without orderId', () => {
      const { orderId, ...paramsWithoutOrderId } = validParams;
      const result = Trade.create(paramsWithoutOrderId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.orderId).toBeUndefined();
      }
    });

    it('should fail validation if id is empty', () => {
      const result = Trade.create({
        ...validParams,
        id: ''
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Trade ID must be a non-empty string');
        expect(result.error.severity).toBe('low');
      }
    });

    it('should fail validation if marketId is empty', () => {
      const result = Trade.create({
        ...validParams,
        marketId: ''
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Market ID must be a non-empty string');
      }
    });

    it('should fail validation if tokenId is empty', () => {
      const result = Trade.create({
        ...validParams,
        tokenId: ''
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Token ID must be a non-empty string');
      }
    });

    it('should fail validation if side is invalid', () => {
      const result = Trade.create({
        ...validParams,
        side: 'INVALID' as any
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid trade side');
      }
    });

    it('should fail validation if timestamp is invalid', () => {
      const result = Trade.create({
        ...validParams,
        timestamp: new Date('invalid')
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid timestamp');
      }
    });

    it('should fail validation if transactionHash is empty', () => {
      const result = Trade.create({
        ...validParams,
        transactionHash: ''
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Transaction hash must be a non-empty string');
      }
    });

    it('should accept BUY side', () => {
      const result = Trade.create({
        ...validParams,
        side: 'BUY'
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.side).toBe('BUY');
      }
    });

    it('should accept SELL side', () => {
      const result = Trade.create({
        ...validParams,
        side: 'SELL'
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.side).toBe('SELL');
      }
    });
  });

  describe('fromValue() - Polymarket event parsing', () => {
    it('should parse valid Polymarket event', () => {
      const event = {
        market: 'market-123',
        asset_id: 'token-yes-456',
        price: '0.65',
        size: '100.5',
        side: 'BUY',
        timestamp: '1705315800000', // 2024-01-15T10:30:00.000Z
        transaction_hash: '0x1234abcd...'
      };

      const result = Trade.fromValue(event);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.marketId).toBe('market-123');
        expect(result.value.tokenId).toBe('token-yes-456');
        expect(result.value.price.value).toBe(0.65);
        expect(result.value.size.value).toBe(100.5);
        expect(result.value.side).toBe('BUY');
        expect(result.value.transactionHash).toBe('0x1234abcd...');
      }
    });

    it('should parse SELL side', () => {
      const event = {
        market: 'market-123',
        asset_id: 'token-no-789',
        price: '0.35',
        size: '50',
        side: 'SELL',
        timestamp: '1705315800000',
        transaction_hash: '0xabcd1234...'
      };

      const result = Trade.fromValue(event);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.side).toBe('SELL');
      }
    });

    it('should handle lowercase side', () => {
      const event = {
        market: 'market-123',
        asset_id: 'token-yes-456',
        price: '0.65',
        size: '100',
        side: 'buy', // lowercase
        timestamp: '1705315800000',
        transaction_hash: '0x1234abcd...'
      };

      const result = Trade.fromValue(event);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.side).toBe('BUY');
      }
    });

    it('should use transaction_hash as ID', () => {
      const event = {
        market: 'market-123',
        asset_id: 'token-yes-456',
        price: '0.65',
        size: '100',
        side: 'BUY',
        timestamp: '1705315800000',
        transaction_hash: '0x1234abcd...'
      };

      const result = Trade.fromValue(event);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('0x1234abcd...');
        expect(result.value.transactionHash).toBe('0x1234abcd...');
      }
    });

    it('should fail for invalid price', () => {
      const event = {
        market: 'market-123',
        asset_id: 'token-yes-456',
        price: '10.0', // Invalid: > 0.9999
        size: '100',
        side: 'BUY',
        timestamp: '1705315800000',
        transaction_hash: '0x1234abcd...'
      };

      const result = Trade.fromValue(event);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid price');
      }
    });

    it('should fail for invalid size', () => {
      const event = {
        market: 'market-123',
        asset_id: 'token-yes-456',
        price: '0.65',
        size: '-100', // Negative
        side: 'BUY',
        timestamp: '1705315800000',
        transaction_hash: '0x1234abcd...'
      };

      const result = Trade.fromValue(event);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid size');
      }
    });

    it('should fail for invalid timestamp', () => {
      const event = {
        market: 'market-123',
        asset_id: 'token-yes-456',
        price: '0.65',
        size: '100',
        side: 'BUY',
        timestamp: 'invalid',
        transaction_hash: '0x1234abcd...'
      };

      const result = Trade.fromValue(event);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid timestamp');
      }
    });
  });

  describe('business methods', () => {
    describe('getNotional()', () => {
      it('should calculate notional value', () => {
        const result = Trade.create(validParams);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getNotional()).toBe(65.0); // 0.65 * 100
        }
      });

      it('should calculate notional for SELL trade', () => {
        const result = Trade.create({
          ...validParams,
          side: 'SELL',
          price: createPrice(0.35),
          size: createQuantity(50)
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getNotional()).toBe(17.5); // 0.35 * 50
        }
      });
    });

    describe('isBuy() and isSell()', () => {
      it('isBuy() should return true for BUY trade', () => {
        const result = Trade.create({
          ...validParams,
          side: 'BUY'
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isBuy()).toBe(true);
          expect(result.value.isSell()).toBe(false);
        }
      });

      it('isSell() should return true for SELL trade', () => {
        const result = Trade.create({
          ...validParams,
          side: 'SELL'
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isBuy()).toBe(false);
          expect(result.value.isSell()).toBe(true);
        }
      });
    });

    describe('getAgeMs() and isRecent()', () => {
      it('getAgeMs() should return age in milliseconds', () => {
        const now = Date.now();
        const result = Trade.create({
          ...validParams,
          timestamp: new Date(now - 5000) // 5 seconds ago
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          const ageMs = result.value.getAgeMs();
          expect(ageMs).toBeGreaterThanOrEqual(4999);
          expect(ageMs).toBeLessThan(6000);
        }
      });

      it('isRecent() should return true for fresh trade', () => {
        const result = Trade.create({
          ...validParams,
          timestamp: new Date(Date.now() - 1000) // 1 second ago
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isRecent(60000)).toBe(true);
        }
      });

      it('isRecent() should return false for old trade', () => {
        const result = Trade.create({
          ...validParams,
          timestamp: new Date(Date.now() - 120000) // 2 minutes ago
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isRecent(60000)).toBe(false);
        }
      });
    });

    describe('compareByTime()', () => {
      it('should compare trades by timestamp', () => {
        const trade1Result = Trade.create({
          ...validParams,
          id: 'trade-1',
          timestamp: new Date('2024-01-15T10:00:00.000Z')
        });

        const trade2Result = Trade.create({
          ...validParams,
          id: 'trade-2',
          timestamp: new Date('2024-01-15T11:00:00.000Z')
        });

        expect(trade1Result.ok && trade2Result.ok).toBe(true);
        if (trade1Result.ok && trade2Result.ok) {
          const comparison = trade1Result.value.compareByTime(trade2Result.value);
          expect(comparison).toBeLessThan(0); // trade1 is earlier
        }
      });
    });
  });

  describe('serialization', () => {
    describe('toJSON()', () => {
      it('should serialize trade to JSON', () => {
        const result = Trade.create(validParams);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const json = result.value.toJSON();

          expect(json.id).toBe('trade-1');
          expect(json.marketId).toBe('market-123');
          expect(json.tokenId).toBe('token-yes-456');
          expect(json.price).toBe(0.65);
          expect(json.size).toBe(100);
          expect(json.side).toBe('BUY');
          expect(json.timestamp).toBe('2024-01-15T10:30:00.000Z');
          expect(json.transactionHash).toBe('0x1234abcd...');
          expect(json.notional).toBe(65.0);
          expect(json.orderId).toBe('order-1');
        }
      });

      it('should include notional in JSON', () => {
        const result = Trade.create(validParams);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const json = result.value.toJSON();
          expect(json.notional).toBe(65.0);
        }
      });
    });

    describe('fromJSON()', () => {
      it('should deserialize trade from JSON', () => {
        const json = {
          id: 'trade-1',
          marketId: 'market-123',
          tokenId: 'token-yes-456',
          price: 0.65,
          size: 100,
          side: 'BUY',
          timestamp: '2024-01-15T10:30:00.000Z',
          transactionHash: '0x1234abcd...',
          orderId: 'order-1'
        };

        const result = Trade.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.id).toBe('trade-1');
          expect(result.value.marketId).toBe('market-123');
          expect(result.value.tokenId).toBe('token-yes-456');
          expect(result.value.price.value).toBe(0.65);
          expect(result.value.size.value).toBe(100);
          expect(result.value.side).toBe('BUY');
        }
      });

      it('should fail for invalid JSON', () => {
        const result = Trade.fromJSON('invalid');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('JSON must be an object');
        }
      });

      it('should round-trip through JSON', () => {
        const createResult = Trade.create(validParams);

        expect(createResult.ok).toBe(true);
        if (createResult.ok) {
          const json = createResult.value.toJSON();
          const fromJsonResult = Trade.fromJSON(json);

          expect(fromJsonResult.ok).toBe(true);
          if (fromJsonResult.ok) {
            expect(fromJsonResult.value.id).toBe(createResult.value.id);
            expect(fromJsonResult.value.marketId).toBe(createResult.value.marketId);
            expect(fromJsonResult.value.tokenId).toBe(createResult.value.tokenId);
            expect(fromJsonResult.value.price.value).toBe(createResult.value.price.value);
            expect(fromJsonResult.value.size.value).toBe(createResult.value.size.value);
          }
        }
      });
    });
  });

  describe('toString()', () => {
    it('should return formatted string', () => {
      const result = Trade.create(validParams);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const str = result.value.toString();
        expect(str).toContain('trade-1');
        expect(str).toContain('BUY');
        expect(str).toContain('100');
        expect(str).toContain('0.65');
        expect(str).toContain('2024-01-15T10:30:00.000Z');
      }
    });
  });
});

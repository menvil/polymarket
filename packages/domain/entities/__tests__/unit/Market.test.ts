/**
 * Market entity unit tests
 *
 * @remarks
 * Тестирует создание, валидацию, lifecycle и сериализацию Market entity.
 */

import { describe, it, expect } from '@jest/globals';
import { Market } from '../../src/Market';

describe('Market entity', () => {
  // Валидные параметры для тестов
  const validProps = {
    id: 'market-123',
    slug: 'btc-100k-2024',
    question: 'Will BTC reach $100k in 2024?',
    outcomeNames: ['Yes', 'No'] as const,
    outcomeTokenIds: ['token-yes-456', 'token-no-789'] as const,
    expirationDate: new Date('2024-12-31T23:59:59Z'),
    status: 'ACTIVE' as const
  };

  describe('create() factory method', () => {
    it('should create valid market with Result<Ok>', () => {
      const result = Market.create(validProps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('market-123');
        expect(result.value.slug).toBe('btc-100k-2024');
        expect(result.value.question).toBe('Will BTC reach $100k in 2024?');
        expect(result.value.status).toBe('ACTIVE');
        expect(result.value.outcomeTokens).toHaveLength(2);
        expect(result.value.outcomeTokens[0].name).toBe('Yes');
        expect(result.value.outcomeTokens[1].name).toBe('No');
      }
    });

    it('should create OutcomeToken entities with correct properties', () => {
      const result = Market.create(validProps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const token0 = result.value.outcomeTokens[0];
        const token1 = result.value.outcomeTokens[1];

        expect(token0.id).toBe('token-yes-456');
        expect(token0.marketId).toBe('market-123');
        expect(token0.outcomeIndex).toBe(0);
        expect(token0.name).toBe('Yes');

        expect(token1.id).toBe('token-no-789');
        expect(token1.marketId).toBe('market-123');
        expect(token1.outcomeIndex).toBe(1);
        expect(token1.name).toBe('No');
      }
    });

    it('should fail validation if id is empty', () => {
      const result = Market.create({
        ...validProps,
        id: ''
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Market ID must be a non-empty string');
        expect(result.error.severity).toBe('low');
      }
    });

    it('should fail validation if slug is empty', () => {
      const result = Market.create({
        ...validProps,
        slug: ''
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Market slug must be a non-empty string');
      }
    });

    it('should fail validation if question is empty', () => {
      const result = Market.create({
        ...validProps,
        question: ''
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Market question must be a non-empty string');
      }
    });

    it('should fail validation if outcomeNames has wrong count', () => {
      const result = Market.create({
        ...validProps,
        outcomeNames: ['Yes'] as any
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Market must have exactly 2 outcome names');
      }
    });

    it('should fail validation if outcomeTokenIds has wrong count', () => {
      const result = Market.create({
        ...validProps,
        outcomeTokenIds: ['token-1', 'token-2', 'token-3'] as any
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Market must have exactly 2 outcome token IDs');
      }
    });

    it('should fail validation if outcome name is empty', () => {
      const result = Market.create({
        ...validProps,
        outcomeNames: ['', 'No'] as const
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Outcome name at index 0 must be a non-empty string');
      }
    });

    it('should fail validation if expirationDate is invalid', () => {
      const result = Market.create({
        ...validProps,
        expirationDate: new Date('invalid')
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Market expiration date must be a valid Date');
      }
    });

    it('should fail validation if status is invalid', () => {
      const result = Market.create({
        ...validProps,
        status: 'INVALID' as any
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid market status');
      }
    });

    it('should fail validation if RESOLVED without resolvedOutcomeIndex', () => {
      const result = Market.create({
        ...validProps,
        status: 'RESOLVED'
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Resolved market must have resolvedOutcomeIndex');
      }
    });

    it('should create RESOLVED market with valid resolvedOutcomeIndex', () => {
      const result = Market.create({
        ...validProps,
        status: 'RESOLVED',
        resolvedOutcomeIndex: 0
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('RESOLVED');
        expect(result.value.resolvedOutcomeIndex).toBe(0);
      }
    });
  });

  describe('marketUrl getter', () => {
    it('should generate correct marketUrl from slug', () => {
      const result = Market.create(validProps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.marketUrl).toBe('https://polymarket.com/event/btc-100k-2024');
      }
    });
  });

  describe('getOutcomeToken()', () => {
    it('should return outcome token by index', () => {
      const result = Market.create(validProps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const token0 = result.value.getOutcomeToken(0);
        const token1 = result.value.getOutcomeToken(1);

        expect(token0.name).toBe('Yes');
        expect(token1.name).toBe('No');
      }
    });
  });

  describe('getOutcomeIndexByTokenId()', () => {
    it('should return index by token ID', () => {
      const result = Market.create(validProps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getOutcomeIndexByTokenId('token-yes-456')).toBe(0);
        expect(result.value.getOutcomeIndexByTokenId('token-no-789')).toBe(1);
      }
    });

    it('should return null for unknown token ID', () => {
      const result = Market.create(validProps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getOutcomeIndexByTokenId('unknown')).toBe(null);
      }
    });
  });

  describe('getOutcomeTokenById()', () => {
    it('should return outcome token by token ID', () => {
      const result = Market.create(validProps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const token = result.value.getOutcomeTokenById('token-yes-456');
        expect(token).not.toBe(null);
        expect(token?.name).toBe('Yes');
      }
    });

    it('should return null for unknown token ID', () => {
      const result = Market.create(validProps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getOutcomeTokenById('unknown')).toBe(null);
      }
    });
  });

  describe('lifecycle methods', () => {
    describe('close()', () => {
      it('should transition ACTIVE → CLOSED', () => {
        const result = Market.create(validProps);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const activeMarket = result.value;
          expect(activeMarket.status).toBe('ACTIVE');

          const closedMarket = activeMarket.close();
          expect(closedMarket.status).toBe('CLOSED');
          expect(closedMarket.id).toBe(activeMarket.id);
        }
      });

      it('should preserve all other properties', () => {
        const result = Market.create(validProps);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const closedMarket = result.value.close();

          expect(closedMarket.id).toBe('market-123');
          expect(closedMarket.slug).toBe('btc-100k-2024');
          expect(closedMarket.question).toBe('Will BTC reach $100k in 2024?');
          expect(closedMarket.outcomeTokens[0].name).toBe('Yes');
        }
      });
    });

    describe('resolve()', () => {
      it('should transition to RESOLVED with outcome 0', () => {
        const result = Market.create({
          ...validProps,
          status: 'CLOSED'
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          const resolveResult = result.value.resolve(0);

          expect(resolveResult.ok).toBe(true);
          if (resolveResult.ok) {
            expect(resolveResult.value.status).toBe('RESOLVED');
            expect(resolveResult.value.resolvedOutcomeIndex).toBe(0);
          }
        }
      });

      it('should transition to RESOLVED with outcome 1', () => {
        const result = Market.create({
          ...validProps,
          status: 'CLOSED'
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          const resolveResult = result.value.resolve(1);

          expect(resolveResult.ok).toBe(true);
          if (resolveResult.ok) {
            expect(resolveResult.value.resolvedOutcomeIndex).toBe(1);
          }
        }
      });

      it('should fail with invalid outcome index', () => {
        const result = Market.create({
          ...validProps,
          status: 'CLOSED'
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          const resolveResult = result.value.resolve(2 as any);

          expect(resolveResult.ok).toBe(false);
          if (!resolveResult.ok) {
            expect(resolveResult.error.message).toContain('Invalid outcome index');
          }
        }
      });
    });
  });

  describe('getResolvedOutcomeToken()', () => {
    it('should return winning outcome for RESOLVED market', () => {
      const result = Market.create({
        ...validProps,
        status: 'RESOLVED',
        resolvedOutcomeIndex: 0
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const winner = result.value.getResolvedOutcomeToken();
        expect(winner).not.toBe(null);
        expect(winner?.name).toBe('Yes');
      }
    });

    it('should return null for non-RESOLVED market', () => {
      const result = Market.create({
        ...validProps,
        status: 'ACTIVE'
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getResolvedOutcomeToken()).toBe(null);
      }
    });
  });

  describe('serialization', () => {
    describe('toJSON()', () => {
      it('should serialize market to JSON', () => {
        const result = Market.create(validProps);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const json = result.value.toJSON();

          expect(json.id).toBe('market-123');
          expect(json.slug).toBe('btc-100k-2024');
          expect(json.marketUrl).toBe('https://polymarket.com/event/btc-100k-2024');
          expect(json.question).toBe('Will BTC reach $100k in 2024?');
          expect(json.status).toBe('ACTIVE');
          expect(json.expirationDate).toBe('2024-12-31T23:59:59.000Z');

          const tokens = json.outcomeTokens as any[];
          expect(tokens).toHaveLength(2);
          expect(tokens[0].id).toBe('token-yes-456');
          expect(tokens[0].name).toBe('Yes');
          expect(tokens[0].outcomeIndex).toBe(0);
        }
      });
    });

    describe('fromJSON()', () => {
      it('should deserialize market from JSON', () => {
        const json = {
          id: 'market-123',
          slug: 'btc-100k-2024',
          question: 'Will BTC reach $100k in 2024?',
          outcomeTokens: [
            { id: 'token-yes-456', name: 'Yes' },
            { id: 'token-no-789', name: 'No' }
          ],
          expirationDate: '2024-12-31T23:59:59.000Z',
          status: 'ACTIVE'
        };

        const result = Market.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.id).toBe('market-123');
          expect(result.value.slug).toBe('btc-100k-2024');
          expect(result.value.question).toBe('Will BTC reach $100k in 2024?');
          expect(result.value.outcomeTokens[0].name).toBe('Yes');
          expect(result.value.outcomeTokens[1].name).toBe('No');
        }
      });

      it('should fail for invalid JSON', () => {
        const result = Market.fromJSON('invalid');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('JSON must be an object');
        }
      });

      it('should round-trip through JSON', () => {
        const createResult = Market.create(validProps);

        expect(createResult.ok).toBe(true);
        if (createResult.ok) {
          const json = createResult.value.toJSON();
          const fromJsonResult = Market.fromJSON(json);

          expect(fromJsonResult.ok).toBe(true);
          if (fromJsonResult.ok) {
            expect(fromJsonResult.value.id).toBe(createResult.value.id);
            expect(fromJsonResult.value.slug).toBe(createResult.value.slug);
            expect(fromJsonResult.value.question).toBe(createResult.value.question);
          }
        }
      });
    });
  });

  describe('utility methods', () => {
    it('isExpired() should return false for future date', () => {
      const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24); // +1 day
      const result = Market.create({
        ...validProps,
        expirationDate: futureDate
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isExpired()).toBe(false);
      }
    });

    it('isExpired() should return true for past date', () => {
      const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24); // -1 day
      const result = Market.create({
        ...validProps,
        expirationDate: pastDate
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isExpired()).toBe(true);
      }
    });

    it('isActive() should return true for ACTIVE status', () => {
      const result = Market.create({
        ...validProps,
        status: 'ACTIVE'
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isActive()).toBe(true);
      }
    });

    it('isResolved() should return true for RESOLVED status', () => {
      const result = Market.create({
        ...validProps,
        status: 'RESOLVED',
        resolvedOutcomeIndex: 0
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isResolved()).toBe(true);
      }
    });

    it('canTrade() should return true for ACTIVE and not expired', () => {
      const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24);
      const result = Market.create({
        ...validProps,
        status: 'ACTIVE',
        expirationDate: futureDate
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.canTrade()).toBe(true);
      }
    });

    it('canTrade() should return false for expired ACTIVE market', () => {
      const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24);
      const result = Market.create({
        ...validProps,
        status: 'ACTIVE',
        expirationDate: pastDate
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.canTrade()).toBe(false);
      }
    });

    it('toString() should return formatted string', () => {
      const result = Market.create(validProps);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const str = result.value.toString();
        expect(str).toContain('market-123');
        expect(str).toContain('Will BTC reach $100k in 2024?');
        expect(str).toContain('[Yes/No]');
        expect(str).toContain('ACTIVE');
      }
    });
  });
});

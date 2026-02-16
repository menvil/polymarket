import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import {
  parseWalletAddress,
  KnownOnChainProtocols,
  KnownChainIds,
  BinaryOutcome,
  KnownVenues,
  accountIdFromWallet,
} from '@polymarket/ids';
import type { OnChainConditionRef, ConditionId, AccountId, VenueId } from '@polymarket/ids';
import { OutcomeToken } from '../../../../src/outcome-token/core/OutcomeToken.js';
import { Quantity } from '../../../../src/quantity/core/Quantity.js';
import { TokenBalanceService } from '../../../../src/token-balance/facade/TokenBalanceService.js';
import { TokenBalanceSerializer } from '../../../../src/token-balance/adapters/TokenBalanceSerializer.js';
import { TokenBalanceErrorReason } from '../../../../src/token-balance/errors/TokenBalanceErrorReason.js';

describe('TokenBalanceSerializer', () => {
  const conditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234' as ConditionId,
  };

  const token = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
  const qty = Quantity.of(new Decimal('100.5'));

  // Test fixtures для accountId и venueId
  const walletAddress = parseWalletAddress('0x1234567890123456789012345678901234567890')!;
  const accountId: AccountId = accountIdFromWallet(walletAddress);
  const venueId: VenueId = KnownVenues.POLYMARKET;

  describe('toJSON()', () => {
    it('сериализует TokenBalance в JSON', () => {
      const balance = TokenBalanceService.create(token, qty, Quantity.ZERO, accountId, venueId);
      expect(balance.ok).toBe(true);
      if (!balance.ok) return;

      const json = TokenBalanceSerializer.toJSON(balance.value);

      expect(json).toEqual({
        token: {
          conditionRef: {
            kind: 'ONCHAIN',
            protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
            chainId: 137,
            conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          },
          outcomeKey: BinaryOutcome.UP,
        },
        available: '100.5',
        reserved: '0',
        accountId: 'wallet:0x1234567890123456789012345678901234567890',
        venueId: 'POLYMARKET',
      });
    });

    it('сохраняет точность available в строке', () => {
      const preciseQty = Quantity.of(new Decimal('123.45678901234567890123456789'));
      const balance = TokenBalanceService.create(token, preciseQty, Quantity.ZERO, accountId, venueId);
      expect(balance.ok).toBe(true);
      if (!balance.ok) return;

      const json = TokenBalanceSerializer.toJSON(balance.value);

      expect(json.available).toBe('123.45678901234567890123456789');
      expect(json.reserved).toBe('0');
    });

    it('сериализует нулевой баланс', () => {
      const zeroQty = Quantity.ZERO;
      const balance = TokenBalanceService.create(token, zeroQty, Quantity.ZERO, accountId, venueId);
      expect(balance.ok).toBe(true);
      if (!balance.ok) return;

      const json = TokenBalanceSerializer.toJSON(balance.value);

      expect(json.available).toBe('0');
      expect(json.reserved).toBe('0');
    });
  });

  describe('fromJSON()', () => {
    it('десериализует валидный JSON', () => {
      const json = {
        token: {
          conditionRef: {
            kind: 'ONCHAIN',
            protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
            chainId: 137,
            conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          },
          outcomeKey: 'UP',
        },
        available: '100.5',
        reserved: '0',
        accountId: 'wallet:0x1234567890123456789012345678901234567890',
        venueId: 'POLYMARKET',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcomeKey()).toBe(BinaryOutcome.UP);
        expect(result.value.available().toNumber()).toBe(100.5);
        expect(result.value.reserved().toNumber()).toBe(0);
        expect(result.value.conditionRef()).toEqual(conditionRef);
      }
    });

    it('десериализует нулевой баланс', () => {
      const json = {
        token: {
          conditionRef: {
            kind: 'ONCHAIN',
            protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
            chainId: 137,
            conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          },
          outcomeKey: 'UP',
        },
        available: '0',
        reserved: '0',
        accountId: 'wallet:0x1234567890123456789012345678901234567890',
        venueId: 'POLYMARKET',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isZero()).toBe(true);
      }
    });

    it('сохраняет точность при round-trip', () => {
      const preciseQty = Quantity.of(new Decimal('123.45678901234567890123456789'));
      const originalBalance = TokenBalanceService.create(token, preciseQty, Quantity.ZERO, accountId, venueId);
      expect(originalBalance.ok).toBe(true);
      if (!originalBalance.ok) return;

      const json = TokenBalanceSerializer.toJSON(originalBalance.value);
      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.available().value().toString()).toBe('123.45678901234567890123456789');
        expect(result.value.reserved().value().toString()).toBe('0');
      }
    });

    it('фэйлится если json не объект', () => {
      const result = TokenBalanceSerializer.fromJSON(null);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
      }
    });

    it('фэйлится если json массив', () => {
      const result = TokenBalanceSerializer.fromJSON([]);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
      }
    });

    it('фэйлится если отсутствует token', () => {
      const json = {
        available: '100.5',
        reserved: '0',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain("Missing required field 'token'");
      }
    });

    it('фэйлится если отсутствует amount', () => {
      const json = {
        token: {
          conditionRef: {
            kind: 'ONCHAIN',
            protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
            chainId: 137,
            conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          },
          outcomeKey: 'UP',
        },
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain("Missing required field 'available'");
      }
    });

    it('фэйлится если token некорректен', () => {
      const json = {
        token: {
          invalid: 'data',
        },
        available: '100.5',
        reserved: '0',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_TOKEN);
      }
    });

    it('фэйлится если amount не строка', () => {
      const json = {
        token: {
          conditionRef: {
            kind: 'ONCHAIN',
            protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
            chainId: 137,
            conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          },
          outcomeKey: 'UP',
        },
        available: 100.5, // number вместо string
        reserved: '0',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain("Field 'available' must be string");
      }
    });

    it('фэйлится если amount не парсится как Decimal', () => {
      const json = {
        token: {
          conditionRef: {
            kind: 'ONCHAIN',
            protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
            chainId: 137,
            conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          },
          outcomeKey: 'UP',
        },
        available: 'invalid',
        reserved: '0',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain('Failed to parse available as Decimal');
      }
    });

    it('фэйлится если amount отрицательное', () => {
      const json = {
        token: {
          conditionRef: {
            kind: 'ONCHAIN',
            protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
            chainId: 137,
            conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          },
          outcomeKey: 'UP',
        },
        available: '-100.5',
        reserved: '0',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain('Failed to create Quantity');
      }
    });

    it('фэйлится если отсутствует accountId', () => {
      const json = {
        token: {
          conditionRef: {
            kind: 'ONCHAIN',
            protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
            chainId: 137,
            conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          },
          outcomeKey: 'UP',
        },
        available: '100.5',
        reserved: '0',
        venueId: 'POLYMARKET',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain("Missing required field 'accountId'");
      }
    });

    it('фэйлится если accountId не строка', () => {
      const json = {
        token: {
          conditionRef: {
            kind: 'ONCHAIN',
            protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
            chainId: 137,
            conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          },
          outcomeKey: 'UP',
        },
        available: '100.5',
        reserved: '0',
        accountId: 123, // number вместо string
        venueId: 'POLYMARKET',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain("Field 'accountId' must be string");
      }
    });

    it('фэйлится если accountId невалидный', () => {
      const json = {
        token: {
          conditionRef: {
            kind: 'ONCHAIN',
            protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
            chainId: 137,
            conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          },
          outcomeKey: 'UP',
        },
        available: '100.5',
        reserved: '0',
        accountId: 'invalid-format', // невалидный формат
        venueId: 'POLYMARKET',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('Failed to parse accountId');
      }
    });

    it('фэйлится если отсутствует venueId', () => {
      const json = {
        token: {
          conditionRef: {
            kind: 'ONCHAIN',
            protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
            chainId: 137,
            conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          },
          outcomeKey: 'UP',
        },
        available: '100.5',
        reserved: '0',
        accountId: 'wallet:0x1234567890123456789012345678901234567890',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain("Missing required field 'venueId'");
      }
    });

    it('фэйлится если venueId не строка', () => {
      const json = {
        token: {
          conditionRef: {
            kind: 'ONCHAIN',
            protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
            chainId: 137,
            conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          },
          outcomeKey: 'UP',
        },
        available: '100.5',
        reserved: '0',
        accountId: 'wallet:0x1234567890123456789012345678901234567890',
        venueId: 123, // number вместо string
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain("Field 'venueId' must be string");
      }
    });

    it('фэйлится если venueId невалидный формат', () => {
      const json = {
        token: {
          conditionRef: {
            kind: 'ONCHAIN',
            protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
            chainId: 137,
            conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          },
          outcomeKey: 'UP',
        },
        available: '100.5',
        reserved: '0',
        accountId: 'wallet:0x1234567890123456789012345678901234567890',
        venueId: 'invalid-venue-id', // содержит дефисы (недопустимо)
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('invalid format');
      }
    });
  });
});

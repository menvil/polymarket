import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { KnownOnChainProtocols, KnownChainIds, BinaryOutcome } from '@polymarket/ids';
import type { OnChainConditionRef, ConditionId } from '@polymarket/ids';
import { OutcomeToken } from '../../outcome-token/core/OutcomeToken.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { TokenBalanceService } from '../facade/TokenBalanceService.js';
import { TokenBalanceSerializer } from '../adapters/TokenBalanceSerializer.js';
import { TokenBalanceErrorReason } from '../errors/TokenBalanceErrorReason.js';

describe('TokenBalanceSerializer', () => {
  const conditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234' as ConditionId,
  };

  const token = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
  const qty = Quantity.of(new Decimal('100.5'));

  describe('toJSON()', () => {
    it('сериализует TokenBalance в JSON', () => {
      const balance = TokenBalanceService.create(token, qty);
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
        amount: '100.5',
      });
    });

    it('сохраняет точность amount в строке', () => {
      const preciseQty = Quantity.of(new Decimal('123.45678901234567890123456789'));
      const balance = TokenBalanceService.create(token, preciseQty);
      expect(balance.ok).toBe(true);
      if (!balance.ok) return;

      const json = TokenBalanceSerializer.toJSON(balance.value);

      expect(json.amount).toBe('123.45678901234567890123456789');
    });

    it('сериализует нулевой баланс', () => {
      const zeroQty = Quantity.ZERO;
      const balance = TokenBalanceService.create(token, zeroQty);
      expect(balance.ok).toBe(true);
      if (!balance.ok) return;

      const json = TokenBalanceSerializer.toJSON(balance.value);

      expect(json.amount).toBe('0');
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
        amount: '100.5',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcomeKey()).toBe(BinaryOutcome.UP);
        expect(result.value.amount().toNumber()).toBe(100.5);
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
        amount: '0',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isZero()).toBe(true);
      }
    });

    it('сохраняет точность при round-trip', () => {
      const preciseQty = Quantity.of(new Decimal('123.45678901234567890123456789'));
      const originalBalance = TokenBalanceService.create(token, preciseQty);
      expect(originalBalance.ok).toBe(true);
      if (!originalBalance.ok) return;

      const json = TokenBalanceSerializer.toJSON(originalBalance.value);
      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().value().toString()).toBe('123.45678901234567890123456789');
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
        amount: '100.5',
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
        expect(result.error.message).toContain("Missing required field 'amount'");
      }
    });

    it('фэйлится если token некорректен', () => {
      const json = {
        token: {
          invalid: 'data',
        },
        amount: '100.5',
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
        amount: 100.5, // number вместо string
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain("Field 'amount' must be string");
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
        amount: 'invalid',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain('Failed to parse amount as Decimal');
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
        amount: '-100.5',
      };

      const result = TokenBalanceSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain('Failed to create Quantity');
      }
    });
  });
});

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
import { OutcomeToken } from '../../outcome-token/core/OutcomeToken.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { TokenBalance } from '../core/TokenBalance.js';

describe('TokenBalance Core', () => {
  const conditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: '0xabc123def4560000000000000000000000000000000000000000000000000000' as ConditionId,
  };

  const token = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
  const qty100 = Quantity.of(new Decimal(100));
  const qty200 = Quantity.of(new Decimal(200));
  const qtyZero = Quantity.ZERO;

  // Test fixtures для accountId и venueId
  const walletAddress = parseWalletAddress('0x1234567890123456789012345678901234567890')!;
  const accountId: AccountId = accountIdFromWallet(walletAddress);
  const venueId: VenueId = KnownVenues.POLYMARKET;

  describe('of()', () => {
    it('создаёт TokenBalance с валидными token и amount', () => {
      const balance = TokenBalance.of(token, qty100, accountId, venueId);

      expect(balance).toBeInstanceOf(TokenBalance);
      expect(balance.token()).toBe(token);
      expect(balance.amount()).toBe(qty100);
    });

    it('создаёт TokenBalance с нулевым amount', () => {
      const balance = TokenBalance.of(token, qtyZero, accountId, venueId);

      expect(balance.amount().isZero()).toBe(true);
    });
  });

  describe('Accessors', () => {
    const balance = TokenBalance.of(token, qty100, accountId, venueId);

    it('token() возвращает OutcomeToken', () => {
      expect(balance.token()).toBe(token);
      expect(balance.token()).toBeInstanceOf(OutcomeToken);
    });

    it('amount() возвращает Quantity', () => {
      expect(balance.amount()).toBe(qty100);
      expect(balance.amount()).toBeInstanceOf(Quantity);
    });
  });

  describe('Helper accessors', () => {
    const balance = TokenBalance.of(token, qty100, accountId, venueId);

    it('assetId() делегирует к token.assetId()', () => {
      const assetId = balance.assetId();

      expect(assetId).toEqual(token.assetId());
      expect(assetId.type).toBe('OUTCOME_TOKEN');
    });

    it('conditionRef() делегирует к token.conditionRef()', () => {
      const ref = balance.conditionRef();

      expect(ref).toEqual(conditionRef);
      expect(ref.kind).toBe('ONCHAIN');
      expect(ref.protocolId).toBe(KnownOnChainProtocols.POLYMARKET_CTF);
      expect(ref.chainId).toBe(137);
    });

    it('outcomeKey() делегирует к token.outcomeKey()', () => {
      const key = balance.outcomeKey();

      expect(key).toBe(BinaryOutcome.UP);
    });
  });

  describe('equals()', () => {
    const token1 = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
    const token2 = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
    const token3 = OutcomeToken.of(conditionRef, BinaryOutcome.DOWN);

    it('возвращает true для одинаковых token и amount', () => {
      const balance1 = TokenBalance.of(token1, qty100, accountId, venueId);
      const balance2 = TokenBalance.of(token2, qty100, accountId, venueId);

      expect(balance1.equals(balance2)).toBe(true);
    });

    it('возвращает false для разных token', () => {
      const balance1 = TokenBalance.of(token1, qty100, accountId, venueId);
      const balance3 = TokenBalance.of(token3, qty100, accountId, venueId);

      expect(balance1.equals(balance3)).toBe(false);
    });

    it('возвращает false для разных amount', () => {
      const balance1 = TokenBalance.of(token1, qty100, accountId, venueId);
      const balance2 = TokenBalance.of(token1, qty200, accountId, venueId);

      expect(balance1.equals(balance2)).toBe(false);
    });

    it('возвращает true для нулевых балансов', () => {
      const balance1 = TokenBalance.of(token1, qtyZero, accountId, venueId);
      const balance2 = TokenBalance.of(token2, qtyZero, accountId, venueId);

      expect(balance1.equals(balance2)).toBe(true);
    });
  });

  describe('isZero()', () => {
    it('возвращает true для нулевого баланса', () => {
      const balance = TokenBalance.of(token, qtyZero, accountId, venueId);

      expect(balance.isZero()).toBe(true);
    });

    it('возвращает false для ненулевого баланса', () => {
      const balance = TokenBalance.of(token, qty100, accountId, venueId);

      expect(balance.isZero()).toBe(false);
    });
  });

  describe('isPositive()', () => {
    it('возвращает false для нулевого баланса', () => {
      const balance = TokenBalance.of(token, qtyZero, accountId, venueId);

      expect(balance.isPositive()).toBe(false);
    });

    it('возвращает true для положительного баланса', () => {
      const balance = TokenBalance.of(token, qty100, accountId, venueId);

      expect(balance.isPositive()).toBe(true);
    });

    it('возвращает true для очень маленького положительного баланса', () => {
      const tinyQty = Quantity.of(new Decimal('0.000001'));
      const balance = TokenBalance.of(token, tinyQty, accountId, venueId);

      expect(balance.isPositive()).toBe(true);
    });
  });

  describe('Immutability', () => {
    it('созданный TokenBalance иммутабелен', () => {
      const balance = TokenBalance.of(token, qty100, accountId, venueId);

      // Попытка изменить amount через получение и модификацию (не должно работать)
      const retrievedAmount = balance.amount();
      expect(retrievedAmount).toBe(qty100);

      // Оригинальный баланс не изменился
      expect(balance.amount()).toBe(qty100);
    });
  });
});

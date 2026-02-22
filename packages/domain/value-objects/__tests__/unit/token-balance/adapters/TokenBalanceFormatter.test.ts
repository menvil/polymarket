import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import {
  KnownOnChainProtocols,
  KnownChainIds,
  BinaryOutcome,
  KnownVenues,
  parseWalletAddress,
  accountIdFromWallet,
} from '@polymarket/ids';
import type { OnChainConditionRef, ConditionId, AccountId, VenueId } from '@polymarket/ids';
import { OutcomeToken } from '../../../../src/outcome-token/core/OutcomeToken.js';
import { Quantity } from '../../../../src/quantity/core/Quantity.js';
import { TokenBalanceService } from '../../../../src/token-balance/facade/TokenBalanceService.js';
import { TokenBalanceFormatter } from '../../../../src/token-balance/adapters/TokenBalanceFormatter.js';

describe('TokenBalanceFormatter', () => {
  const conditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: '0xabc123def4567890000000000000000000000000000000000000000000000000' as ConditionId,
  };

  const token = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
  const qty = Quantity.of(new Decimal('100.5'));

  // Test fixtures для accountId и venueId
  const walletAddress = parseWalletAddress('0x1234567890123456789012345678901234567890')!;
  const accountId: AccountId = accountIdFromWallet(walletAddress);
  const venueId: VenueId = KnownVenues.POLYMARKET;

  const balance = TokenBalanceService.create(token, qty, Quantity.ZERO, accountId, venueId);
  if (!balance.ok) throw new Error('Failed to create balance');
  const testBalance = balance.value;

  describe('toString()', () => {
    it('форматирует TokenBalance как полную строку', () => {
      const str = TokenBalanceFormatter.toString(testBalance);

      expect(str).toContain('TokenBalance');
      expect(str).toContain('available');
      expect(str).toContain('reserved');
      expect(str).toContain('total');
      expect(str).toContain('UP');
      // toString() не включает accountId и venueId в вывод
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toString(testBalance);
      }).not.toThrow();
    });
  });

  describe('toDisplayString()', () => {
    it('форматирует TokenBalance для UI', () => {
      const display = TokenBalanceFormatter.toDisplayString(testBalance);

      expect(display).toContain('100.5');
      expect(display).toContain('UP');
      expect(display).toContain(KnownOnChainProtocols.POLYMARKET_CTF);
      expect(display).toContain('137');
      // Должен содержать сокращенный conditionId
      expect(display).toContain('0xabc1');
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toDisplayString(testBalance);
      }).not.toThrow();
    });
  });

  describe('toShortString()', () => {
    it('форматирует TokenBalance в краткую строку', () => {
      const short = TokenBalanceFormatter.toShortString(testBalance);

      // toShortString теперь показывает total (available + reserved)
      expect(short).toBe('100.5 UP'); // available=100.5, reserved=0, total=100.5
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toShortString(testBalance);
      }).not.toThrow();
    });
  });

  describe('toVerboseString()', () => {
    it('форматирует TokenBalance с полной информацией', () => {
      const verbose = TokenBalanceFormatter.toVerboseString(testBalance);

      expect(verbose).toContain('TokenBalance');
      expect(verbose).toContain('available');
      expect(verbose).toContain('reserved');
      expect(verbose).toContain('total');
      expect(verbose).toContain('UP');
      // toVerboseString() не включает accountId и venueId в вывод
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toVerboseString(testBalance);
      }).not.toThrow();
    });
  });

  describe('toFixedString()', () => {
    it('форматирует amount с 2 десятичными знаками по умолчанию', () => {
      const fixed = TokenBalanceFormatter.toFixedString(testBalance);

      expect(fixed).toBe('100.50 UP');
    });

    it('форматирует amount с заданным числом десятичных знаков', () => {
      const fixed4 = TokenBalanceFormatter.toFixedString(testBalance, 4);

      expect(fixed4).toBe('100.5000 UP');
    });

    it('округляет amount при необходимости', () => {
      const preciseQty = Quantity.of(new Decimal('100.12345'));
      const preciseBalance = TokenBalanceService.create(token, preciseQty, Quantity.ZERO, accountId, venueId);
      expect(preciseBalance.ok).toBe(true);
      if (!preciseBalance.ok) return;

      const fixed2 = TokenBalanceFormatter.toFixedString(preciseBalance.value, 2);

      expect(fixed2).toBe('100.12 UP');
    });

    it('форматирует нулевой баланс', () => {
      const zeroQty = Quantity.ZERO;
      const zeroBalance = TokenBalanceService.create(token, zeroQty, Quantity.ZERO, accountId, venueId);
      expect(zeroBalance.ok).toBe(true);
      if (!zeroBalance.ok) return;

      const fixed = TokenBalanceFormatter.toFixedString(zeroBalance.value, 2);

      expect(fixed).toBe('0.00 UP');
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toFixedString(testBalance);
        TokenBalanceFormatter.toFixedString(testBalance, 4);
        TokenBalanceFormatter.toFixedString(testBalance, 0);
      }).not.toThrow();
    });
  });

  describe('toSummary()', () => {
    it('форматирует полную сводку баланса', () => {
      const balanceWithReserved = TokenBalanceService.create(
        token,
        Quantity.of(new Decimal('100')),
        Quantity.of(new Decimal('20')),
        accountId,
        venueId
      );
      expect(balanceWithReserved.ok).toBe(true);
      if (!balanceWithReserved.ok) return;

      const summary = TokenBalanceFormatter.toSummary(balanceWithReserved.value);

      expect(summary).toContain('Available: 100');
      expect(summary).toContain('Reserved: 20');
      expect(summary).toContain('Total: 120');
      expect(summary).toContain('16.67%'); // reservedPercentage
      expect(summary).toContain('[UP]');
    });

    it('форматирует с заданным числом десятичных знаков', () => {
      const summary0 = TokenBalanceFormatter.toSummary(testBalance, 0);
      expect(summary0).toContain('Available: 101'); // 100.5 округляется до 101
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toSummary(testBalance);
      }).not.toThrow();
    });

    it('включает accountId когда includeAccount=true', () => {
      const summary = TokenBalanceFormatter.toSummary(testBalance, 2, true, false);

      expect(summary).toContain('Account: wallet:0x1234567890123456789012345678901234567890');
      expect(summary).not.toContain('Venue:');
    });

    it('включает venueId когда includeVenue=true', () => {
      const summary = TokenBalanceFormatter.toSummary(testBalance, 2, false, true);

      expect(summary).toContain('Venue: POLYMARKET');
      expect(summary).not.toContain('Account:');
    });

    it('включает оба когда includeAccount и includeVenue=true', () => {
      const summary = TokenBalanceFormatter.toSummary(testBalance, 2, true, true);

      expect(summary).toContain('Account: wallet:0x1234567890123456789012345678901234567890');
      expect(summary).toContain('Venue: POLYMARKET');
      expect(summary).toContain(', '); // разделитель между account и venue
    });
  });

  describe('toCompact()', () => {
    it('форматирует компактную строку', () => {
      const balanceWithReserved = TokenBalanceService.create(
        token,
        Quantity.of(new Decimal('100')),
        Quantity.of(new Decimal('20')),
        accountId,
        venueId
      );
      expect(balanceWithReserved.ok).toBe(true);
      if (!balanceWithReserved.ok) return;

      const compact = TokenBalanceFormatter.toCompact(balanceWithReserved.value);

      // toCompact использует decimals=1 по умолчанию
      expect(compact).toContain('Avail: 100.0');
      expect(compact).toContain('Res: 20.0');
      expect(compact).toContain('Total: 120.0');
      // toCompact НЕ включает токен в строку
    });

    it('форматирует с заданным числом десятичных знаков', () => {
      const compact4 = TokenBalanceFormatter.toCompact(testBalance, 4);
      expect(compact4).toContain('100.5000');
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toCompact(testBalance);
      }).not.toThrow();
    });

    it('включает venueId когда includeVenue=true', () => {
      const compact = TokenBalanceFormatter.toCompact(testBalance, 1, true);

      expect(compact).toContain('Avail: 100.5');
      expect(compact).toContain('@ POLYMARKET');
    });

    it('не включает venue по умолчанию (includeVenue=false)', () => {
      const compact = TokenBalanceFormatter.toCompact(testBalance);

      expect(compact).not.toContain('@');
      expect(compact).not.toContain('POLYMARKET');
    });
  });

  describe('toDebugString()', () => {
    it('форматирует debug строку с полной информацией', () => {
      const debug = TokenBalanceFormatter.toDebugString(testBalance);

      expect(debug).toContain('TokenBalance');
      expect(debug).toContain('available: 100.5');
      expect(debug).toContain('reserved: 0');
      expect(debug).toContain('total: 100.5');
      expect(debug).toContain('token: UP');
      expect(debug).toContain('account: wallet:0x1234567890123456789012345678901234567890');
      expect(debug).toContain('venue: POLYMARKET');
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toDebugString(testBalance);
      }).not.toThrow();
    });
  });

  describe('toAvailableString()', () => {
    it('форматирует available с default decimals (2)', () => {
      const availStr = TokenBalanceFormatter.toAvailableString(testBalance);
      expect(availStr).toBe('100.50');
    });

    it('форматирует available с заданным числом десятичных знаков', () => {
      const availStr0 = TokenBalanceFormatter.toAvailableString(testBalance, 0);
      expect(availStr0).toBe('101'); // 100.5 округляется до 101

      const availStr4 = TokenBalanceFormatter.toAvailableString(testBalance, 4);
      expect(availStr4).toBe('100.5000');
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toAvailableString(testBalance);
      }).not.toThrow();
    });
  });

  describe('toReservedString()', () => {
    it('форматирует reserved с default decimals (2)', () => {
      const resStr = TokenBalanceFormatter.toReservedString(testBalance);
      expect(resStr).toBe('0.00');
    });

    it('форматирует reserved с заданным числом десятичных знаков', () => {
      const balanceWithReserved = TokenBalanceService.create(
        token,
        Quantity.of(new Decimal('100')),
        Quantity.of(new Decimal('20.5')),
        accountId,
        venueId
      );
      expect(balanceWithReserved.ok).toBe(true);
      if (!balanceWithReserved.ok) return;

      const resStr0 = TokenBalanceFormatter.toReservedString(balanceWithReserved.value, 0);
      expect(resStr0).toBe('21'); // 20.5 округляется до 21

      const resStr4 = TokenBalanceFormatter.toReservedString(balanceWithReserved.value, 4);
      expect(resStr4).toBe('20.5000');
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toReservedString(testBalance);
      }).not.toThrow();
    });
  });

  describe('toTotalString()', () => {
    it('форматирует total с default decimals (2)', () => {
      const totalStr = TokenBalanceFormatter.toTotalString(testBalance);
      expect(totalStr).toBe('100.50');
    });

    it('форматирует total с заданным числом десятичных знаков', () => {
      const balanceWithReserved = TokenBalanceService.create(
        token,
        Quantity.of(new Decimal('100')),
        Quantity.of(new Decimal('20.75')),
        accountId,
        venueId
      );
      expect(balanceWithReserved.ok).toBe(true);
      if (!balanceWithReserved.ok) return;

      const totalStr0 = TokenBalanceFormatter.toTotalString(balanceWithReserved.value, 0);
      expect(totalStr0).toBe('121'); // 100 + 20.75 = 120.75 → 121

      const totalStr4 = TokenBalanceFormatter.toTotalString(balanceWithReserved.value, 4);
      expect(totalStr4).toBe('120.7500');
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toTotalString(testBalance);
      }).not.toThrow();
    });
  });

  describe('toPercentageString()', () => {
    it('форматирует процент резервирования с default decimals (2)', () => {
      const balanceWithReserved = TokenBalanceService.create(
        token,
        Quantity.of(new Decimal('100')),
        Quantity.of(new Decimal('20')),
        accountId,
        venueId
      );
      expect(balanceWithReserved.ok).toBe(true);
      if (!balanceWithReserved.ok) return;

      const pctStr = TokenBalanceFormatter.toPercentageString(balanceWithReserved.value);
      expect(pctStr).toBe('16.67%');
    });

    it('форматирует процент с заданным числом десятичных знаков', () => {
      const balanceWithReserved = TokenBalanceService.create(
        token,
        Quantity.of(new Decimal('100')),
        Quantity.of(new Decimal('20')),
        accountId,
        venueId
      );
      expect(balanceWithReserved.ok).toBe(true);
      if (!balanceWithReserved.ok) return;

      const pctStr0 = TokenBalanceFormatter.toPercentageString(balanceWithReserved.value, 0);
      expect(pctStr0).toBe('17%');

      const pctStr4 = TokenBalanceFormatter.toPercentageString(balanceWithReserved.value, 4);
      expect(pctStr4).toBe('16.6667%');
    });

    it('возвращает 0% для баланса без резерва', () => {
      const pctStr = TokenBalanceFormatter.toPercentageString(testBalance);
      expect(pctStr).toBe('0.00%');
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toPercentageString(testBalance);
      }).not.toThrow();
    });
  });
});

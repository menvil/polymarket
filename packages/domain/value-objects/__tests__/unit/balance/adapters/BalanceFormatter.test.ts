import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { BalanceFormatter } from '../../../../src/balance/adapters/BalanceFormatter.js';
import { BalanceService } from '../../../../src/balance/facade/BalanceService.js';
import { Money } from '../../../../src/money/core/Money.js';
import { unwrap } from '@polymarket/result';

describe('BalanceFormatter', () => {
  const createBalance = (available: number, reserved: number) => {
    const result = BalanceService.create(
      Money.of(new Decimal(available)),
      Money.of(new Decimal(reserved))
    );
    if (!result.ok) throw new Error('Failed to create balance');
    return result.value;
  };

  describe('toSummary()', () => {
    it('форматирует полную информацию о балансе', () => {
      const balance = createBalance(10000, 2000);
      const summary = unwrap(BalanceFormatter.toSummary(balance));

      expect(summary).toContain('Available: $10000.00');
      expect(summary).toContain('Reserved: $2000.00');
      expect(summary).toContain('Total: $12000.00');
      expect(summary).toContain('16.67% reserved');
    });

    it('форматирует с указанными decimals', () => {
      const balance = createBalance(10000, 2000);
      const summary = unwrap(BalanceFormatter.toSummary(balance, 0));

      expect(summary).toContain('$10000');
      expect(summary).not.toContain('.00');
    });

    it('форматирует пустой баланс', () => {
      const balance = createBalance(0, 0);
      const summary = unwrap(BalanceFormatter.toSummary(balance));

      expect(summary).toContain('Available: $0.00');
      expect(summary).toContain('Reserved: $0.00');
      expect(summary).toContain('Total: $0.00');
      expect(summary).toContain('0.00% reserved');
    });

    it('возвращает Err для отрицательных decimals', () => {
      const balance = createBalance(10000, 2000);
      const result = BalanceFormatter.toSummary(balance, -1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });

    it('возвращает Err для нецелых decimals', () => {
      const balance = createBalance(10000, 2000);
      const result = BalanceFormatter.toSummary(balance, 2.5);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });
  });

  describe('toCompact()', () => {
    it('форматирует компактно с суффиксами K', () => {
      const balance = createBalance(10000, 2000);
      const compact = unwrap(BalanceFormatter.toCompact(balance));

      expect(compact).toContain('Avail: $10.0K');
      expect(compact).toContain('Res: $2.0K');
      expect(compact).toContain('Total: $12.0K');
    });

    it('форматирует компактно с суффиксами M', () => {
      const balance = createBalance(5000000, 1000000);
      const compact = unwrap(BalanceFormatter.toCompact(balance));

      expect(compact).toContain('$5.0M');
      expect(compact).toContain('$1.0M');
      expect(compact).toContain('$6.0M');
    });

    it('форматирует маленькие числа без суффиксов', () => {
      const balance = createBalance(500, 100);
      const compact = unwrap(BalanceFormatter.toCompact(balance));

      expect(compact).toContain('$500.0');
      expect(compact).toContain('$100.0');
      expect(compact).not.toContain('K');
    });

    it('возвращает Err для отрицательных decimals', () => {
      const balance = createBalance(10000, 2000);
      const result = BalanceFormatter.toCompact(balance, -1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });
  });

  describe('toDebugString()', () => {
    it('форматирует для отладки', () => {
      const balance = createBalance(10000, 2000);
      const debug = BalanceFormatter.toDebugString(balance);

      expect(debug).toContain('Balance(');
      expect(debug).toContain('available: 10000 USDC');
      expect(debug).toContain('reserved: 2000 USDC');
      expect(debug).toContain('total: 12000 USDC');
    });

    it('использует полную точность', () => {
      const balance = createBalance(123.456789, 987.654321);
      const debug = BalanceFormatter.toDebugString(balance);

      expect(debug).toContain('123.456789');
      expect(debug).toContain('987.654321');
    });
  });

  describe('toAvailableString()', () => {
    it('форматирует только available с валютой', () => {
      const balance = createBalance(10000, 2000);
      const str = unwrap(BalanceFormatter.toAvailableString(balance));

      expect(str).toBe('$10000.00 USDC');
    });

    it('форматирует без валюты если showCurrency=false', () => {
      const balance = createBalance(10000, 2000);
      const str = unwrap(BalanceFormatter.toAvailableString(balance, false));

      expect(str).toBe('$10000.00');
      expect(str).not.toContain('USDC');
    });

    it('форматирует с указанными decimals', () => {
      const balance = createBalance(10000.123, 2000);
      const str = unwrap(BalanceFormatter.toAvailableString(balance, true, 3));

      expect(str).toBe('$10000.123 USDC');
    });

    it('возвращает Err для отрицательных decimals', () => {
      const balance = createBalance(10000, 2000);
      const result = BalanceFormatter.toAvailableString(balance, true, -1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });
  });

  describe('toReservedString()', () => {
    it('форматирует только reserved с валютой', () => {
      const balance = createBalance(10000, 2000);
      const str = unwrap(BalanceFormatter.toReservedString(balance));

      expect(str).toBe('$2000.00 USDC');
    });

    it('форматирует без валюты если showCurrency=false', () => {
      const balance = createBalance(10000, 2000);
      const str = unwrap(BalanceFormatter.toReservedString(balance, false));

      expect(str).toBe('$2000.00');
    });

    it('возвращает Err для отрицательных decimals', () => {
      const balance = createBalance(10000, 2000);
      const result = BalanceFormatter.toReservedString(balance, true, -1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });
  });

  describe('toTotalString()', () => {
    it('форматирует только total с валютой', () => {
      const balance = createBalance(10000, 2000);
      const str = unwrap(BalanceFormatter.toTotalString(balance));

      expect(str).toBe('$12000.00 USDC');
    });

    it('форматирует без валюты если showCurrency=false', () => {
      const balance = createBalance(10000, 2000);
      const str = unwrap(BalanceFormatter.toTotalString(balance, false));

      expect(str).toBe('$12000.00');
    });

    it('возвращает Err для отрицательных decimals', () => {
      const balance = createBalance(10000, 2000);
      const result = BalanceFormatter.toTotalString(balance, true, -1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });
  });

  describe('toPercentageString()', () => {
    it('форматирует процент зарезервированных средств', () => {
      const balance = createBalance(8000, 2000);
      const str = unwrap(BalanceFormatter.toPercentageString(balance));

      expect(str).toBe('20.00%');
    });

    it('форматирует с указанными decimals', () => {
      const balance = createBalance(8000, 2000);
      const str = unwrap(BalanceFormatter.toPercentageString(balance, 0));

      expect(str).toBe('20%');
    });

    it('форматирует 0% для пустого баланса', () => {
      const balance = createBalance(0, 0);
      const str = unwrap(BalanceFormatter.toPercentageString(balance));

      expect(str).toBe('0.00%');
    });

    it('форматирует 100% если всё зарезервировано', () => {
      const balance = createBalance(0, 10000);
      const str = unwrap(BalanceFormatter.toPercentageString(balance));

      expect(str).toBe('100.00%');
    });

    it('возвращает Err для отрицательных decimals', () => {
      const balance = createBalance(10000, 2000);
      const result = BalanceFormatter.toPercentageString(balance, -1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });
  });
});

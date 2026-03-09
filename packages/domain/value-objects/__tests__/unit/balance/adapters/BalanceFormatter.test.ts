import Decimal from 'decimal.js';
import { describe, it, expect, jest } from '@jest/globals';
import { BalanceFormatter } from '../../../../src/balance/adapters/BalanceFormatter.js';
import { BalanceService } from '../../../../src/balance/facade/BalanceService.js';
import { Money } from '../../../../src/money/core/Money.js';
import { MoneyFormatter } from '../../../../src/money/adapters/MoneyFormatter.js';
import { unwrap } from '@polymarket/result/unsafe';
import { Err } from '@polymarket/result';
import { TEST_ACCOUNT_ID, TEST_VENUE_ID } from '../../../helpers/balanceTestHelpers.js';
import { InvalidMoneyError } from '@polymarket/errors';

describe('BalanceFormatter', () => {
  const createBalance = (available: number, reserved: number) => {
    const result = BalanceService.create(
      Money.of(new Decimal(available)),
      Money.of(new Decimal(reserved)),
      TEST_ACCOUNT_ID,
      TEST_VENUE_ID
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

  describe('includeAccount and includeVenue flags', () => {
    describe('toSummary() with flags', () => {
      it('включает accountId когда includeAccount = true', () => {
        const balance = createBalance(10000, 2000);
        const summary = unwrap(BalanceFormatter.toSummary(balance, 2, true, false));

        expect(summary).toContain('Account:');
        expect(summary).not.toContain('Venue:');
      });

      it('включает venueId когда includeVenue = true', () => {
        const balance = createBalance(10000, 2000);
        const summary = unwrap(BalanceFormatter.toSummary(balance, 2, false, true));

        expect(summary).not.toContain('Account:');
        expect(summary).toContain('Venue:');
      });

      it('включает оба когда includeAccount = true И includeVenue = true', () => {
        const balance = createBalance(10000, 2000);
        const summary = unwrap(BalanceFormatter.toSummary(balance, 2, true, true));

        expect(summary).toContain('Account:');
        expect(summary).toContain('Venue:');
      });

      it('не включает ни один когда оба = false (default)', () => {
        const balance = createBalance(10000, 2000);
        const summary = unwrap(BalanceFormatter.toSummary(balance, 2, false, false));

        expect(summary).not.toContain('Account:');
        expect(summary).not.toContain('Venue:');
      });
    });

    describe('toCompact() with includeVenue flag', () => {
      it('включает venueId когда includeVenue = true', () => {
        const balance = createBalance(10000, 2000);
        const compact = unwrap(BalanceFormatter.toCompact(balance, 1, true));

        expect(compact).toContain('@');
        expect(compact).toContain('POLYMARKET');
      });

      it('не включает venueId когда includeVenue = false (default)', () => {
        const balance = createBalance(10000, 2000);
        const compact = unwrap(BalanceFormatter.toCompact(balance, 1, false));

        expect(compact).not.toContain('@');
        expect(compact).not.toContain('POLYMARKET');
      });
    });
  });

  describe('Edge cases and extreme values', () => {
    it('toSummary() работает с decimals = 0', () => {
      const balance = createBalance(10000, 2000);
      const summary = unwrap(BalanceFormatter.toSummary(balance, 0));

      expect(summary).toContain('Available: $10000');
      expect(summary).toContain('Reserved: $2000');
      expect(summary).toContain('Total: $12000');
    });

    it('toSummary() работает с большим decimals', () => {
      const balance = createBalance(10000, 2000);
      const summary = unwrap(BalanceFormatter.toSummary(balance, 6));

      expect(summary).toContain('Available: $10000.000000');
      expect(summary).toContain('Reserved: $2000.000000');
    });

    it('toCompact() работает с decimals = 0', () => {
      const balance = createBalance(1500000, 500000);
      const compact = unwrap(BalanceFormatter.toCompact(balance, 0));

      // Большие числа форматируются с M (миллионы) или K (тысячи)
      expect(compact).toMatch(/Avail: \$\d+[KM]/);
      expect(compact).toMatch(/Res: \$\d+[KM]/);
    });

    it('toCompact() работает с decimals = 1', () => {
      const balance = createBalance(150000, 50000);
      const compact = unwrap(BalanceFormatter.toCompact(balance, 1));

      // Используем меньшие числа чтобы получить K вместо M
      expect(compact).toContain('Avail: $150.0K');
      expect(compact).toContain('Res: $50.0K');
    });

    it('toAvailableString() работает с большим balance', () => {
      const balance = createBalance(999999999, 0);
      const available = unwrap(BalanceFormatter.toAvailableString(balance));

      expect(available).toContain('$999999999.00');
    });

    it('toReservedString() работает с нулевым reserved', () => {
      const balance = createBalance(10000, 0);
      const reserved = unwrap(BalanceFormatter.toReservedString(balance));

      expect(reserved).toContain('$0.00');
      expect(reserved).toContain('USDC');
    });

    it('toTotalString() работает для очень маленького баланса', () => {
      const balance = createBalance(1, 1);
      const total = unwrap(BalanceFormatter.toTotalString(balance));

      expect(total).toContain('$2.00');
      expect(total).toContain('USDC');
    });

    it('toPercentageString() возвращает 0% для нулевого reserved', () => {
      const balance = createBalance(10000, 0);
      const percentage = unwrap(BalanceFormatter.toPercentageString(balance));

      expect(percentage).toBe('0.00%');
    });

    it('toPercentageString() возвращает 100% когда available = 0', () => {
      const balance = createBalance(0, 10000);
      const percentage = unwrap(BalanceFormatter.toPercentageString(balance));

      expect(percentage).toBe('100.00%');
    });

    it('toPercentageString() работает с decimals = 0', () => {
      const balance = createBalance(8000, 2000);
      const percentage = unwrap(BalanceFormatter.toPercentageString(balance, 0));

      expect(percentage).toBe('20%');
    });
  });

  describe('MoneyFormatter error branches coverage', () => {
    describe('toSummary() MoneyFormatter errors', () => {
      it('обрабатывает ошибку MoneyFormatter.toCurrency для available', () => {
        const balance = createBalance(10000, 2000);

        // Мокируем MoneyFormatter.toCurrency чтобы вернуть Err
        const formatSpy = jest.spyOn(MoneyFormatter, 'toCurrency').mockReturnValueOnce(
          Err(new InvalidMoneyError('Mock format error'))
        );

        const result = BalanceFormatter.toSummary(balance);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Failed to format available amount');
        }

        formatSpy.mockRestore();
      });

      it('обрабатывает ошибку MoneyFormatter.toCurrency для reserved', () => {
        const balance = createBalance(10000, 2000);

        // Первый вызов toCurrency для available проходит Ok
        // Второй вызов toCurrency для reserved возвращает Err
        const formatSpy = jest.spyOn(MoneyFormatter, 'toCurrency')
          .mockReturnValueOnce({ ok: true, value: '$10000.00' } as any)
          .mockReturnValueOnce(Err(new InvalidMoneyError('Mock format error')));

        const result = BalanceFormatter.toSummary(balance);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Failed to format reserved amount');
        }

        formatSpy.mockRestore();
      });

      it('обрабатывает ошибку MoneyFormatter.toCurrency для total', () => {
        const balance = createBalance(10000, 2000);

        // Первый и второй вызовы toCurrency проходят Ok
        // Третий вызов toCurrency для total возвращает Err
        const formatSpy = jest.spyOn(MoneyFormatter, 'toCurrency')
          .mockReturnValueOnce({ ok: true, value: '$10000.00' } as any)
          .mockReturnValueOnce({ ok: true, value: '$2000.00' } as any)
          .mockReturnValueOnce(Err(new InvalidMoneyError('Mock format error')));

        const result = BalanceFormatter.toSummary(balance);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Failed to format total amount');
        }

        formatSpy.mockRestore();
      });
    });

    describe('toCompact() MoneyFormatter errors', () => {
      it('обрабатывает ошибку MoneyFormatter.toCompact для available', () => {
        const balance = createBalance(10000, 2000);

        // Мокируем MoneyFormatter.toCompact чтобы вернуть Err
        const formatSpy = jest.spyOn(MoneyFormatter, 'toCompact').mockReturnValueOnce(
          Err(new InvalidMoneyError('Mock format error'))
        );

        const result = BalanceFormatter.toCompact(balance);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Failed to format available amount');
        }

        formatSpy.mockRestore();
      });

      it('обрабатывает ошибку MoneyFormatter.toCompact для reserved', () => {
        const balance = createBalance(10000, 2000);

        // Первый вызов toCompact для available проходит Ok
        // Второй вызов toCompact для reserved возвращает Err
        const formatSpy = jest.spyOn(MoneyFormatter, 'toCompact')
          .mockReturnValueOnce({ ok: true, value: '$10.0K' } as any)
          .mockReturnValueOnce(Err(new InvalidMoneyError('Mock format error')));

        const result = BalanceFormatter.toCompact(balance);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Failed to format reserved amount');
        }

        formatSpy.mockRestore();
      });

      it('обрабатывает ошибку MoneyFormatter.toCompact для total', () => {
        const balance = createBalance(10000, 2000);

        // Первый и второй вызовы toCompact проходят Ok
        // Третий вызов toCompact для total возвращает Err
        const formatSpy = jest.spyOn(MoneyFormatter, 'toCompact')
          .mockReturnValueOnce({ ok: true, value: '$10.0K' } as any)
          .mockReturnValueOnce({ ok: true, value: '$2.0K' } as any)
          .mockReturnValueOnce(Err(new InvalidMoneyError('Mock format error')));

        const result = BalanceFormatter.toCompact(balance);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Failed to format total amount');
        }

        formatSpy.mockRestore();
      });
    });

    describe('toAvailableString() MoneyFormatter errors', () => {
      it('обрабатывает ошибку MoneyFormatter.toCurrency', () => {
        const balance = createBalance(10000, 2000);

        // Мокируем MoneyFormatter.toCurrency чтобы вернуть Err
        const formatSpy = jest.spyOn(MoneyFormatter, 'toCurrency').mockReturnValueOnce(
          Err(new InvalidMoneyError('Mock format error'))
        );

        const result = BalanceFormatter.toAvailableString(balance);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Failed to format available amount');
        }

        formatSpy.mockRestore();
      });
    });

    describe('toReservedString() MoneyFormatter errors', () => {
      it('обрабатывает ошибку MoneyFormatter.toCurrency', () => {
        const balance = createBalance(10000, 2000);

        // Мокируем MoneyFormatter.toCurrency чтобы вернуть Err
        const formatSpy = jest.spyOn(MoneyFormatter, 'toCurrency').mockReturnValueOnce(
          Err(new InvalidMoneyError('Mock format error'))
        );

        const result = BalanceFormatter.toReservedString(balance);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Failed to format reserved amount');
        }

        formatSpy.mockRestore();
      });
    });

    describe('toTotalString() MoneyFormatter errors', () => {
      it('обрабатывает ошибку MoneyFormatter.toCurrency', () => {
        const balance = createBalance(10000, 2000);

        // Мокируем MoneyFormatter.toCurrency чтобы вернуть Err
        const formatSpy = jest.spyOn(MoneyFormatter, 'toCurrency').mockReturnValueOnce(
          Err(new InvalidMoneyError('Mock format error'))
        );

        const result = BalanceFormatter.toTotalString(balance);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Failed to format total amount');
        }

        formatSpy.mockRestore();
      });
    });
  });
});

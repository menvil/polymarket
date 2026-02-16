import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { Balance } from '../../../../src/balance/core/Balance.js';
import { BalanceInvariantViolation } from '../../../../src/balance/core/BalanceInvariantViolation.js';
import { Money } from '../../../../src/money/core/Money.js';
import { TEST_ACCOUNT_ID, TEST_VENUE_ID } from '../../../helpers/balanceTestHelpers.js';

describe('Balance Core', () => {
  describe('Balance.of() - успешное создание', () => {
    it('создаёт баланс с положительными available и reserved', () => {
      const available = Money.of(new Decimal(10000));
      const reserved = Money.of(new Decimal(2000));

      const balance = Balance.of(available, reserved, TEST_ACCOUNT_ID, TEST_VENUE_ID);

      expect(balance.available()).toBe(available);
      expect(balance.reserved()).toBe(reserved);
      expect(balance.currency()).toBe('USDC');
    });

    it('создаёт баланс с нулевым reserved', () => {
      const available = Money.of(new Decimal(10000));
      const reserved = Money.of(new Decimal(0));

      const balance = Balance.of(available, reserved, TEST_ACCOUNT_ID, TEST_VENUE_ID);

      expect(balance.available().value().toNumber()).toBe(10000);
      expect(balance.reserved().value().toNumber()).toBe(0);
    });

    it('создаёт баланс с нулевым available', () => {
      const available = Money.of(new Decimal(0));
      const reserved = Money.of(new Decimal(5000));

      const balance = Balance.of(available, reserved, TEST_ACCOUNT_ID, TEST_VENUE_ID);

      expect(balance.available().value().toNumber()).toBe(0);
      expect(balance.reserved().value().toNumber()).toBe(5000);
    });

    it('создаёт пустой баланс (оба нулевые)', () => {
      const available = Money.of(new Decimal(0));
      const reserved = Money.of(new Decimal(0));

      const balance = Balance.of(available, reserved, TEST_ACCOUNT_ID, TEST_VENUE_ID);

      expect(balance.isZero()).toBe(true);
      expect(balance.total().value().toNumber()).toBe(0);
    });
  });

  describe('Balance.of() - нарушение инвариантов', () => {
    // ПРИМЕЧАНИЕ: Тесты NaN/Infinity невозможны на уровне Balance
    // Money.fromDecimal() уже бросает MoneyInvariantViolation для NaN/Infinity,
    // поэтому Balance.of() никогда не получит такие значения.
    // Balance имеет defense-in-depth проверки NaN/Infinity, но их нельзя протестировать напрямую
    // потому что Money защищает нас на более раннем уровне (композиция VO).
    //
    // Архитектурно это правильно: Money - это базовый VO, который должен быть всегда валидным.
    // Balance (композитный VO) дополнительно проверяет, но эти проверки срабатывают только
    // если Money-слой пропустит невалидные данные (что невозможно по дизайну).

    it('бросает BalanceInvariantViolation если available отрицательный', () => {
      const available = Money.of(new Decimal(-100), 'USDC');
      const reserved = Money.of(new Decimal(0));

      expect(() => Balance.of(available, reserved, TEST_ACCOUNT_ID, TEST_VENUE_ID)).toThrow(BalanceInvariantViolation);
      expect(() => Balance.of(available, reserved, TEST_ACCOUNT_ID, TEST_VENUE_ID)).toThrow('Available amount cannot be negative');
    });

    it('бросает BalanceInvariantViolation если reserved отрицательный', () => {
      const available = Money.of(new Decimal(10000));
      const reserved = Money.of(new Decimal(-100), 'USDC');

      expect(() => Balance.of(available, reserved, TEST_ACCOUNT_ID, TEST_VENUE_ID)).toThrow(BalanceInvariantViolation);
      expect(() => Balance.of(available, reserved, TEST_ACCOUNT_ID, TEST_VENUE_ID)).toThrow('Reserved amount cannot be negative');
    });

    // ПРИМЕЧАНИЕ: Тест невозможен, так как Money поддерживает только USDC
    // it('бросает BalanceInvariantViolation если валюты не совпадают', () => {
    //   const available = Money.of(new Decimal(10000));
    //   const reserved = Money.of(2000, 'EUR' as any); // разные валюты
    //
    //   expect(() => Balance.of(available, reserved)).toThrow(BalanceInvariantViolation);
    //   expect(() => Balance.of(available, reserved)).toThrow('Available and reserved must have the same currency');
    // });

    // ПРИМЕЧАНИЕ: Тесты для NAN/NON_FINITE reason невозможны
    // (см. комментарий выше о defense-in-depth проверках)

    it('проверяет reason в BalanceInvariantViolation для NEGATIVE_AVAILABLE', () => {
      const available = Money.of(new Decimal(-100), 'USDC');
      const reserved = Money.of(new Decimal(0));

      try {
        Balance.of(available, reserved, TEST_ACCOUNT_ID, TEST_VENUE_ID);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BalanceInvariantViolation);
        if (error instanceof BalanceInvariantViolation) {
          expect(error.reason).toBe('NEGATIVE_AVAILABLE');
        }
      }
    });

    it('проверяет reason в BalanceInvariantViolation для NEGATIVE_RESERVED', () => {
      const available = Money.of(new Decimal(10000));
      const reserved = Money.of(new Decimal(-100), 'USDC');

      try {
        Balance.of(available, reserved, TEST_ACCOUNT_ID, TEST_VENUE_ID);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BalanceInvariantViolation);
        if (error instanceof BalanceInvariantViolation) {
          expect(error.reason).toBe('NEGATIVE_RESERVED');
        }
      }
    });

    it('бросает BalanceInvariantViolation если available + reserved > Money.MAX_AMOUNT', () => {
      // Money.MAX_AMOUNT = 1e15
      // Создаём два больших валидных Money, сумма которых превышает лимит
      const available = Money.of(new Decimal('6e14')); // 600 триллионов
      const reserved = Money.of(new Decimal('5e14'));  // 500 триллионов
      // total = 1.1e15 > 1e15 (MAX_AMOUNT)

      expect(() => Balance.of(available, reserved, TEST_ACCOUNT_ID, TEST_VENUE_ID)).toThrow(BalanceInvariantViolation);
      expect(() => Balance.of(available, reserved, TEST_ACCOUNT_ID, TEST_VENUE_ID)).toThrow('exceeds maximum');
    });

    it('проверяет reason в BalanceInvariantViolation для TOTAL_EXCEEDS_MAX_AMOUNT', () => {
      const available = Money.of(new Decimal('6e14'));
      const reserved = Money.of(new Decimal('5e14'));

      try {
        Balance.of(available, reserved, TEST_ACCOUNT_ID, TEST_VENUE_ID);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BalanceInvariantViolation);
        if (error instanceof BalanceInvariantViolation) {
          expect(error.reason).toBe('TOTAL_EXCEEDS_MAX_AMOUNT');
          expect((error as any).total).toBeDefined();
          expect((error as any).maxAmount).toBeDefined();
          expect((error as any).available).toBeDefined();
          expect((error as any).reserved).toBeDefined();
        }
      }
    });

    it('принимает баланс на границе MAX_AMOUNT (available + reserved = MAX_AMOUNT)', () => {
      // Money.MAX_AMOUNT = 1e15
      const available = Money.of(new Decimal('6e14'));
      const reserved = Money.of(new Decimal('4e14'));
      // total = 1e15 = MAX_AMOUNT (граница, должно пройти)

      const balance = Balance.of(available, reserved, TEST_ACCOUNT_ID, TEST_VENUE_ID);

      expect(balance.total().value().toString()).toBe('1000000000000000');
    });

    // ПРИМЕЧАНИЕ: Тест невозможен, так как Money поддерживает только USDC
    // it('проверяет reason в BalanceInvariantViolation для CURRENCY_MISMATCH', () => {
    //   const available = Money.of(new Decimal(10000));
    //   const reserved = Money.of(2000, 'EUR' as any);
    //
    //   try {
    //     Balance.of(available, reserved);
    //     fail('Should have thrown');
    //   } catch (error) {
    //     expect(error).toBeInstanceOf(BalanceInvariantViolation);
    //     if (error instanceof BalanceInvariantViolation) {
    //       expect(error.reason).toBe('CURRENCY_MISMATCH');
    //     }
    //   }
    // });
  });

  describe('Balance.ZERO - singleton', () => {
    it('создаёт пустой баланс через ZERO.USDC', () => {
      const balance = Balance.ZERO.USDC;

      expect(balance.available().value().toNumber()).toBe(0);
      expect(balance.reserved().value().toNumber()).toBe(0);
      expect(balance.currency()).toBe('USDC');
      expect(balance.isZero()).toBe(true);
    });

    it('ZERO.USDC - это всегда один и тот же экземпляр (singleton)', () => {
      const balance1 = Balance.ZERO.USDC;
      const balance2 = Balance.ZERO.USDC;

      expect(balance1).toBe(balance2);
    });
  });

  describe('Balance.withZeroReserved() - helper', () => {
    it('создаёт баланс с нулевым reserved', () => {
      const available = Money.of(new Decimal(10000));
      const balance = Balance.withZeroReserved(available, TEST_ACCOUNT_ID, TEST_VENUE_ID);

      expect(balance.available().value().toNumber()).toBe(10000);
      expect(balance.reserved().value().toNumber()).toBe(0);
      expect(balance.currency()).toBe('USDC');
    });
  });

  describe('Query методы', () => {
    const balance = Balance.of(
      Money.of(new Decimal(10000)),
      Money.of(new Decimal(2000)),
      TEST_ACCOUNT_ID,
      TEST_VENUE_ID
    );

    describe('total()', () => {
      it('возвращает сумму available и reserved', () => {
        expect(balance.total().value().toNumber()).toBe(12000);
      });
    });

    describe('currency()', () => {
      it('возвращает валюту баланса', () => {
        expect(balance.currency()).toBe('USDC');
      });
    });

    describe('isEmpty()', () => {
      it('возвращает false для непустого баланса', () => {
        expect(balance.isZero()).toBe(false);
      });

      it('возвращает true для пустого баланса', () => {
        const empty = Balance.ZERO.USDC;
        expect(empty.isZero()).toBe(true);
      });

      it('возвращает false если есть только reserved', () => {
        const onlyReserved = Balance.of(Money.of(new Decimal(0)), Money.of(new Decimal(100)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        expect(onlyReserved.isZero()).toBe(false);
      });
    });

    describe('hasReserved()', () => {
      it('возвращает true если есть зарезервированные средства', () => {
        expect(balance.hasReserved()).toBe(true);
      });

      it('возвращает false если нет зарезервированных средств', () => {
        const noReserved = Balance.withZeroReserved(Money.of(new Decimal(10000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        expect(noReserved.hasReserved()).toBe(false);
      });
    });

    describe('reservedPercentage()', () => {
      it('вычисляет процент зарезервированных средств', () => {
        const percentage = balance.reservedPercentage();
        // 2000 / 12000 * 100 = 16.666...
        expect(percentage.toFixed(2)).toBe('16.67');
      });

      it('возвращает 0 для пустого баланса', () => {
        const empty = Balance.ZERO.USDC;
        expect(empty.reservedPercentage().toNumber()).toBe(0);
      });

      it('возвращает 100 если всё зарезервировано', () => {
        const allReserved = Balance.of(Money.of(new Decimal(0)), Money.of(new Decimal(10000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        expect(allReserved.reservedPercentage().toNumber()).toBe(100);
      });

      it('возвращает 50 если половина зарезервирована', () => {
        const halfReserved = Balance.of(Money.of(new Decimal(5000)), Money.of(new Decimal(5000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        expect(halfReserved.reservedPercentage().toNumber()).toBe(50);
      });
    });

    describe('hasSameCurrency()', () => {
      it('возвращает true для балансов с одинаковой валютой', () => {
        const balance1 = Balance.of(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        const balance2 = Balance.of(Money.of(new Decimal(5000)), Money.of(new Decimal(1000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);

        expect(balance1.hasSameCurrency(balance2)).toBe(true);
      });

      // ПРИМЕЧАНИЕ: Тест для разных валют невозможен, так как Money поддерживает только USDC
      // it('возвращает false для балансов с разными валютами', () => {
      //   const balance1 = Balance.of(Money.of(new Decimal(10000), 'USDC'), Money.of(new Decimal(2000), 'USDC'));
      //   const balance2 = Balance.of(Money.of(new Decimal(5000), 'EUR'), Money.of(new Decimal(1000), 'EUR'));
      //
      //   expect(balance1.hasSameCurrency(balance2)).toBe(false);
      // });
    });
  });
});

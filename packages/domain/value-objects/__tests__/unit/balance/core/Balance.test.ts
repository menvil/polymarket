import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { Balance } from '../../../../src/balance/core/Balance.js';
import { BalanceInvariantViolation } from '../../../../src/balance/core/BalanceInvariantViolation.js';
import { Money } from '../../../../src/money/core/Money.js';

describe('Balance Core', () => {
  describe('Balance.of() - успешное создание', () => {
    it('создаёт баланс с положительными available и reserved', () => {
      const available = Money.of(10000);
      const reserved = Money.of(2000);

      const balance = Balance.of(available, reserved);

      expect(balance.available()).toBe(available);
      expect(balance.reserved()).toBe(reserved);
      expect(balance.currency()).toBe('USDC');
    });

    it('создаёт баланс с нулевым reserved', () => {
      const available = Money.of(10000);
      const reserved = Money.of(0);

      const balance = Balance.of(available, reserved);

      expect(balance.available().value().toNumber()).toBe(10000);
      expect(balance.reserved().value().toNumber()).toBe(0);
    });

    it('создаёт баланс с нулевым available', () => {
      const available = Money.of(0);
      const reserved = Money.of(5000);

      const balance = Balance.of(available, reserved);

      expect(balance.available().value().toNumber()).toBe(0);
      expect(balance.reserved().value().toNumber()).toBe(5000);
    });

    it('создаёт пустой баланс (оба нулевые)', () => {
      const available = Money.of(0);
      const reserved = Money.of(0);

      const balance = Balance.of(available, reserved);

      expect(balance.isEmpty()).toBe(true);
      expect(balance.total().value().toNumber()).toBe(0);
    });
  });

  describe('Balance.of() - нарушение инвариантов', () => {
    it('бросает BalanceInvariantViolation если available отрицательный', () => {
      const available = Money.of(-100, 'USDC');
      const reserved = Money.of(0);

      expect(() => Balance.of(available, reserved)).toThrow(BalanceInvariantViolation);
      expect(() => Balance.of(available, reserved)).toThrow('Available amount cannot be negative');
    });

    it('бросает BalanceInvariantViolation если reserved отрицательный', () => {
      const available = Money.of(10000);
      const reserved = Money.of(-100, 'USDC');

      expect(() => Balance.of(available, reserved)).toThrow(BalanceInvariantViolation);
      expect(() => Balance.of(available, reserved)).toThrow('Reserved amount cannot be negative');
    });

    // ПРИМЕЧАНИЕ: Тест невозможен, так как Money поддерживает только USDC
    // it('бросает BalanceInvariantViolation если валюты не совпадают', () => {
    //   const available = Money.of(10000);
    //   const reserved = Money.of(2000, 'EUR' as any); // разные валюты
    //
    //   expect(() => Balance.of(available, reserved)).toThrow(BalanceInvariantViolation);
    //   expect(() => Balance.of(available, reserved)).toThrow('Available and reserved must have the same currency');
    // });

    it('проверяет reason в BalanceInvariantViolation для NEGATIVE_AVAILABLE', () => {
      const available = Money.of(-100, 'USDC');
      const reserved = Money.of(0);

      try {
        Balance.of(available, reserved);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BalanceInvariantViolation);
        if (error instanceof BalanceInvariantViolation) {
          expect(error.reason).toBe('NEGATIVE_AVAILABLE');
        }
      }
    });

    it('проверяет reason в BalanceInvariantViolation для NEGATIVE_RESERVED', () => {
      const available = Money.of(10000);
      const reserved = Money.of(-100, 'USDC');

      try {
        Balance.of(available, reserved);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BalanceInvariantViolation);
        if (error instanceof BalanceInvariantViolation) {
          expect(error.reason).toBe('NEGATIVE_RESERVED');
        }
      }
    });

    // ПРИМЕЧАНИЕ: Тест невозможен, так как Money поддерживает только USDC
    // it('проверяет reason в BalanceInvariantViolation для CURRENCY_MISMATCH', () => {
    //   const available = Money.of(10000);
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

  describe('Balance.zero() - helper', () => {
    it('создаёт пустой баланс', () => {
      const balance = Balance.zero('USDC');

      expect(balance.available().value().toNumber()).toBe(0);
      expect(balance.reserved().value().toNumber()).toBe(0);
      expect(balance.currency()).toBe('USDC');
      expect(balance.isEmpty()).toBe(true);
    });
  });

  describe('Balance.withZeroReserved() - helper', () => {
    it('создаёт баланс с нулевым reserved', () => {
      const available = Money.of(10000);
      const balance = Balance.withZeroReserved(available);

      expect(balance.available().value().toNumber()).toBe(10000);
      expect(balance.reserved().value().toNumber()).toBe(0);
      expect(balance.currency()).toBe('USDC');
    });
  });

  describe('Query методы', () => {
    const balance = Balance.of(
      Money.of(10000),
      Money.of(2000)
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
        expect(balance.isEmpty()).toBe(false);
      });

      it('возвращает true для пустого баланса', () => {
        const empty = Balance.zero('USDC');
        expect(empty.isEmpty()).toBe(true);
      });

      it('возвращает false если есть только reserved', () => {
        const onlyReserved = Balance.of(Money.of(0), Money.of(100));
        expect(onlyReserved.isEmpty()).toBe(false);
      });
    });

    describe('hasReserved()', () => {
      it('возвращает true если есть зарезервированные средства', () => {
        expect(balance.hasReserved()).toBe(true);
      });

      it('возвращает false если нет зарезервированных средств', () => {
        const noReserved = Balance.withZeroReserved(Money.of(10000));
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
        const empty = Balance.zero('USDC');
        expect(empty.reservedPercentage().toNumber()).toBe(0);
      });

      it('возвращает 100 если всё зарезервировано', () => {
        const allReserved = Balance.of(Money.of(0), Money.of(10000));
        expect(allReserved.reservedPercentage().toNumber()).toBe(100);
      });

      it('возвращает 50 если половина зарезервирована', () => {
        const halfReserved = Balance.of(Money.of(5000), Money.of(5000));
        expect(halfReserved.reservedPercentage().toNumber()).toBe(50);
      });
    });

    describe('canAfford()', () => {
      it('возвращает true если available >= amount', () => {
        expect(balance.canAfford(Money.of(5000))).toBe(true);
        expect(balance.canAfford(Money.of(10000))).toBe(true);
      });

      it('возвращает false если available < amount', () => {
        expect(balance.canAfford(Money.of(15000))).toBe(false);
      });

      it('возвращает true для нулевой суммы', () => {
        expect(balance.canAfford(Money.of(0))).toBe(true);
      });
    });

    describe('equals()', () => {
      it('возвращает true для идентичных балансов', () => {
        const balance1 = Balance.of(Money.of(10000), Money.of(2000));
        const balance2 = Balance.of(Money.of(10000), Money.of(2000));

        expect(balance1.equals(balance2, new Decimal(0.01))).toBe(true);
      });

      it('возвращает true если разница в пределах epsilon', () => {
        const balance1 = Balance.of(Money.of(10000), Money.of(2000));
        const balance2 = Balance.of(Money.of(10000.001), Money.of(2000));

        expect(balance1.equals(balance2, new Decimal(0.01))).toBe(true);
      });

      it('возвращает false если разница превышает epsilon', () => {
        const balance1 = Balance.of(Money.of(10000), Money.of(2000));
        const balance2 = Balance.of(Money.of(10000.1), Money.of(2000));

        expect(balance1.equals(balance2, new Decimal(0.01))).toBe(false);
      });

      // ПРИМЕЧАНИЕ: Тест невозможен, так как Money поддерживает только USDC
      // it('возвращает false для разных валют', () => {
      //   const balance1 = Balance.of(Money.of(10000), Money.of(2000));
      //   const balance2 = Balance.of(Money.of(10000, 'EUR' as any), Money.of(2000, 'EUR' as any));
      //
      //   expect(balance1.equals(balance2, new Decimal(0.01))).toBe(false);
      // });
    });
  });
});

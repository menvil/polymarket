/**
 * Тесты для Money value object
 */

import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { unwrap } from '@polymarket/result';
import { Money } from '../../src/Money';
import {
  InvalidMoneyError,
  DivisionByZeroError,
  ArithmeticOverflowError,
  CurrencyMismatchError
} from '@polymarket/errors';

/**
 * Test helper to create Money with arbitrary currency for testing edge cases
 */
function createMoneyForTest(amount: Decimal | number, currency: string): Money {
  const decimal = amount instanceof Decimal ? amount : new Decimal(amount);
  return new (Money as any)(decimal, currency);
}

describe('Money', () => {
  describe('Фабричные методы', () => {
    describe('fromValue', () => {
      describe('with number', () => {
        it('должен создать Money из положительного числа', () => {
          const result = Money.fromValue(100);

          expect(result.ok).toBe(true);
          if (result.ok) {
            const money = result.value;
            expect(money.getAmount()).toBe(100);
            expect(money.getCurrency()).toBe('USDC');
          }
        });

        it('должен создать Money с явной валютой', () => {
          const result = Money.fromValue(100, 'USDC');

          expect(result.ok).toBe(true);
          if (result.ok) {
            const money = result.value;
            expect(money.getCurrency()).toBe('USDC');
          }
        });

        it('должен создать Money из отрицательного числа (для PnL)', () => {
          const result = Money.fromValue(-50);

          expect(result.ok).toBe(true);
          if (result.ok) {
            const money = result.value;
            expect(money.getAmount()).toBe(-50);
            expect(money.isNegative()).toBe(true);
          }
        });

        it('должен создать Money из нуля', () => {
          const result = Money.fromValue(0);

          expect(result.ok).toBe(true);
          if (result.ok) {
            const money = result.value;
            expect(money.isZero()).toBe(true);
          }
        });

        it('должен создать Money из дробного числа', () => {
          const result = Money.fromValue(100.50);

          expect(result.ok).toBe(true);
          if (result.ok) {
            const money = result.value;
            expect(money.getAmount()).toBe(100.50);
          }
        });

        it('должен отклонить NaN', () => {
          const result = Money.fromValue(NaN);

          expect(result.ok).toBe(false);
          if (!result.ok) {
            const error = result.error;
            expect(error).toBeInstanceOf(InvalidMoneyError);
            expect(error.context?.reason).toBe('NaN');
          }
        });

        it('должен отклонить Infinity', () => {
          const result = Money.fromValue(Infinity);

          expect(result.ok).toBe(false);
          if (!result.ok) {
            const error = result.error;
            expect(error).toBeInstanceOf(InvalidMoneyError);
            expect(error.context?.reason).toBe('Infinity');
          }
        });

        it('должен отклонить отрицательный Infinity', () => {
          const result = Money.fromValue(-Infinity);

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBeInstanceOf(InvalidMoneyError);
          }
        });

        it('должен отклонить пустую валюту', () => {
          const result = Money.fromValue(100, '' as 'USDC');

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBeInstanceOf(InvalidMoneyError);
            expect(result.error.message).toContain('Unsupported currency');
          }
        });

        it('должен отклонить невалидную валюту (пробелы)', () => {
          const result = Money.fromValue(100, '   ' as 'USDC');

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBeInstanceOf(InvalidMoneyError);
            expect(result.error.message).toContain('Unsupported currency');
          }
        });
      });

      describe('with Decimal', () => {
        it('должен создать Money из Decimal', () => {
          const decimal = new Decimal('100.123456789');
          const result = Money.fromValue(decimal);

          expect(result.ok).toBe(true);
          if (result.ok) {
            const money = result.value;
            expect(money.toDecimal().toString()).toBe('100.123456789');
          }
        });

        it('должен отклонить неконечный Decimal', () => {
          const decimal = new Decimal(Infinity);
          const result = Money.fromValue(decimal);

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBeInstanceOf(InvalidMoneyError);
          }
        });
      });

      describe('with string', () => {
        it('должен создать Money из валидной строки', () => {
          const result = Money.fromValue('100.123456789');

          expect(result.ok).toBe(true);
          if (result.ok) {
            const money = result.value;
            expect(money.toDecimal().toString()).toBe('100.123456789');
          }
        });

        it('должен создать Money из отрицательной строки', () => {
          const result = Money.fromValue('-50.25');

          expect(result.ok).toBe(true);
          if (result.ok) {
            const money = result.value;
            expect(money.getAmount()).toBe(-50.25);
          }
        });

        it('должен отклонить невалидную строку', () => {
          const result = Money.fromValue('invalid');

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBeInstanceOf(InvalidMoneyError);
          }
        });

        it('должен отклонить пустую строку', () => {
          const result = Money.fromValue('');

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBeInstanceOf(InvalidMoneyError);
          }
        });
      });

      describe('default currency', () => {
        it('должен создать USDC Money по умолчанию', () => {
          const result = Money.fromValue(100);

          expect(result.ok).toBe(true);
          if (result.ok) {
            const money = result.value;
            expect(money.getAmount()).toBe(100);
            expect(money.getCurrency()).toBe('USDC');
          }
        });

        it('дефолт должен быть эквивалентен явному USDC', () => {
          const m1 = unwrap(Money.fromValue(100));
          const m2 = unwrap(Money.fromValue(100, 'USDC'));

          expect(m1.equals(m2)).toBe(true);
        });
      });

      describe('MAX_AMOUNT validation', () => {
        it('должен отклонить положительное значение превышающее MAX_AMOUNT', () => {
          const result = Money.fromValue(2e15); // Больше чем 1e15

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBeInstanceOf(InvalidMoneyError);
            expect(result.error.message).toContain('exceeds MAX_AMOUNT');
          }
        });

        it('должен отклонить отрицательное значение превышающее MAX_AMOUNT', () => {
          const result = Money.fromValue(-2e15); // Меньше чем -1e15

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBeInstanceOf(InvalidMoneyError);
            expect(result.error.message).toContain('exceeds MAX_AMOUNT');
          }
        });

        it('должен принять значение равное MAX_AMOUNT', () => {
          const result = Money.fromValue(1e15);

          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value.getAmount()).toBe(1e15);
          }
        });
      });
    });

    describe('zero', () => {
      it('должен создать нулевой Money', () => {
        const zero = Money.zero();

        expect(zero.isZero()).toBe(true);
        expect(zero.getAmount()).toBe(0);
        expect(zero.getCurrency()).toBe('USDC');
      });

      it('должен создать ноль с указанной валютой', () => {
        const zero = Money.zero('USDC');

        expect(zero.getCurrency()).toBe('USDC');
      });
    });
  });

  describe('Математические операции', () => {
    describe('add', () => {
      it('должен сложить две денежные суммы', () => {
        const m1 = unwrap(Money.fromValue(100));
        const m2 = unwrap(Money.fromValue(50));

        const result = m1.add(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const sum = result.value;
          expect(sum.getAmount()).toBe(150);
        }
      });

      it('должен складывать отрицательные суммы', () => {
        const m1 = unwrap(Money.fromValue(100));
        const m2 = unwrap(Money.fromValue(-30));

        const result = m1.add(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getAmount()).toBe(70);
        }
      });

      it('не должен изменять исходные значения', () => {
        const m1 = unwrap(Money.fromValue(100));
        const m2 = unwrap(Money.fromValue(50));

        m1.add(m2);

        expect(m1.getAmount()).toBe(100);
        expect(m2.getAmount()).toBe(50);
      });

      it('должен отклонить операцию с разными валютами', () => {
        const usd = unwrap(Money.fromValue(100, 'USDC'));
        const btc = createMoneyForTest(1, 'BTC');

        const result = usd.add(btc);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(CurrencyMismatchError);
          expect(result.error.message).toContain('Cannot add');
        }
      });

      it('должен отклонить сложение с превышением MAX_AMOUNT', () => {
        const m1 = unwrap(Money.fromValue(9e14));
        const m2 = unwrap(Money.fromValue(2e14)); // Сумма = 1.1e15 > MAX_AMOUNT

        const result = m1.add(m2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(ArithmeticOverflowError);
          expect(result.error.message).toContain('overflow');
        }
      });

      it('должен отклонить сложение приводящее к не конечному значению', () => {
        const m1 = createMoneyForTest(Number.MAX_VALUE, 'USDC');
        const m2 = createMoneyForTest(Number.MAX_VALUE, 'USDC');

        const result = m1.add(m2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(ArithmeticOverflowError);
        }
      });
    });

    describe('subtract', () => {
      it('должен вычесть две денежные суммы', () => {
        const m1 = unwrap(Money.fromValue(100));
        const m2 = unwrap(Money.fromValue(30));

        const result = m1.subtract(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getAmount()).toBe(70);
        }
      });

      it('должен разрешать отрицательный результат (для PnL)', () => {
        const m1 = unwrap(Money.fromValue(50));
        const m2 = unwrap(Money.fromValue(100));

        const result = m1.subtract(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const diff = result.value;
          expect(diff.getAmount()).toBe(-50);
          expect(diff.isNegative()).toBe(true);
        }
      });

      it('не должен изменять исходные значения', () => {
        const m1 = unwrap(Money.fromValue(100));
        const m2 = unwrap(Money.fromValue(30));

        m1.subtract(m2);

        expect(m1.getAmount()).toBe(100);
        expect(m2.getAmount()).toBe(30);
      });

      it('должен отклонить операцию с разными валютами', () => {
        const usd = unwrap(Money.fromValue(100, 'USDC'));
        const eth = createMoneyForTest(2, 'ETH');

        const result = usd.subtract(eth);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(CurrencyMismatchError);
          expect(result.error.message).toContain('Cannot subtract');
        }
      });

      it('должен отклонить вычитание с превышением MAX_AMOUNT по модулю', () => {
        const m1 = unwrap(Money.fromValue(-9e14));
        const m2 = unwrap(Money.fromValue(2e14)); // Результат = -1.1e15, |результат| > MAX_AMOUNT

        const result = m1.subtract(m2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(ArithmeticOverflowError);
          expect(result.error.message).toContain('overflow');
        }
      });

      it('должен отклонить вычитание приводящее к не конечному значению', () => {
        const m1 = createMoneyForTest(Number.MAX_VALUE, 'USDC');
        const m2 = createMoneyForTest(-Number.MAX_VALUE, 'USDC');

        const result = m1.subtract(m2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(ArithmeticOverflowError);
        }
      });
    });

    describe('multiply', () => {
      it('должен умножать на число', () => {
        const money = unwrap(Money.fromValue(100));

        const result = money.multiply(2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getAmount()).toBe(200);
        }
      });

      it('должен умножать на Decimal', () => {
        const money = unwrap(Money.fromValue(100));
        const factor = new Decimal('1.5');

        const result = money.multiply(factor);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getAmount()).toBe(150);
        }
      });

      it('должен умножать на дробное число', () => {
        const money = unwrap(Money.fromValue(100));

        const result = money.multiply(0.5);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getAmount()).toBe(50);
        }
      });

      it('должен обрабатывать отрицательное умножение', () => {
        const money = unwrap(Money.fromValue(100));

        const result = money.multiply(-1);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getAmount()).toBe(-100);
        }
      });

      it('должен отклонять переполнение', () => {
        const money = unwrap(Money.fromValue(1e15));

        const result = money.multiply(1000);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(ArithmeticOverflowError);
        }
      });

      it('не должен изменять исходное значение', () => {
        const money = unwrap(Money.fromValue(100));

        money.multiply(2);

        expect(money.getAmount()).toBe(100);
      });
    });

    describe('divide', () => {
      it('должен делить на число', () => {
        const money = unwrap(Money.fromValue(100));

        const result = money.divide(2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getAmount()).toBe(50);
        }
      });

      it('должен делить на Decimal', () => {
        const money = unwrap(Money.fromValue(100));
        const divisor = new Decimal('4');

        const result = money.divide(divisor);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getAmount()).toBe(25);
        }
      });

      it('должен отклонять деление на ноль', () => {
        const money = unwrap(Money.fromValue(100));

        const result = money.divide(0);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          const error = result.error;
          expect(error).toBeInstanceOf(DivisionByZeroError);
        }
      });

      it('должен отклонять деление на нулевой Decimal', () => {
        const money = unwrap(Money.fromValue(100));

        const result = money.divide(new Decimal(0));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(DivisionByZeroError);
        }
      });

      it('не должен изменять исходное значение', () => {
        const money = unwrap(Money.fromValue(100));

        money.divide(2);

        expect(money.getAmount()).toBe(100);
      });

      it('должен отклонять деление на NaN', () => {
        const money = unwrap(Money.fromValue(100));

        const result = money.divide(NaN);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(DivisionByZeroError);
          expect(result.error.message).toContain('must be a finite number');
        }
      });

      it('должен отклонять деление на Infinity', () => {
        const money = unwrap(Money.fromValue(100));

        const result = money.divide(Infinity);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(DivisionByZeroError);
          expect(result.error.message).toContain('must be a finite number');
        }
      });

      it('должен отклонять деление на -Infinity', () => {
        const money = unwrap(Money.fromValue(100));

        const result = money.divide(-Infinity);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(DivisionByZeroError);
          expect(result.error.message).toContain('must be a finite number');
        }
      });

      it('должен отклонять деление на Decimal NaN', () => {
        const money = unwrap(Money.fromValue(100));

        const result = money.divide(new Decimal(NaN));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(DivisionByZeroError);
          expect(result.error.message).toContain('must be a finite number');
        }
      });

      it('должен отклонить деление с превышением MAX_AMOUNT', () => {
        const money = unwrap(Money.fromValue(1e15)); // MAX_AMOUNT
        const divisor = 0.1; // Результат = 1e16 > MAX_AMOUNT

        const result = money.divide(divisor);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(ArithmeticOverflowError);
          expect(result.error.message).toContain('overflow');
        }
      });

      it('должен отклонить деление отрицательного числа с превышением MAX_AMOUNT', () => {
        const money = unwrap(Money.fromValue(-1e15)); // -MAX_AMOUNT
        const divisor = 0.1; // |Результат| = 1e16 > MAX_AMOUNT

        const result = money.divide(divisor);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(ArithmeticOverflowError);
          expect(result.error.message).toContain('overflow');
        }
      });

      it('должен отклонить деление приводящее к ошибке вычисления', () => {
        const money = createMoneyForTest(new Decimal('1e308'), 'USDC');
        const divisor = new Decimal('1e-308');

        const result = money.divide(divisor);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(ArithmeticOverflowError);
        }
      });
    });
  });

  describe('Сравнение', () => {
    describe('equals', () => {
      it('должен возвращать true для равных сумм', () => {
        const m1 = unwrap(Money.fromValue(100));
        const m2 = unwrap(Money.fromValue(100));

        expect(m1.equals(m2)).toBe(true);
      });

      it('должен возвращать false для разных сумм', () => {
        const m1 = unwrap(Money.fromValue(100));
        const m2 = unwrap(Money.fromValue(50));

        expect(m1.equals(m2)).toBe(false);
      });

      it('должен быть рефлексивным', () => {
        const money = unwrap(Money.fromValue(100));

        expect(money.equals(money)).toBe(true);
      });

      it('должен корректно обрабатывать десятичную точность', () => {
        const m1 = unwrap(Money.fromValue('0.1'));
        const m2 = unwrap(Money.fromValue('0.10'));

        expect(m1.equals(m2)).toBe(true);
      });
    });

    describe('greaterThan', () => {
      it('должен возвращать true когда больше', () => {
        const m1 = unwrap(Money.fromValue(100));
        const m2 = unwrap(Money.fromValue(50));

        const result = m1.greaterThan(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('должен возвращать false когда меньше', () => {
        const m1 = unwrap(Money.fromValue(50));
        const m2 = unwrap(Money.fromValue(100));

        const result = m1.greaterThan(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('должен возвращать false когда равно', () => {
        const m1 = unwrap(Money.fromValue(100));
        const m2 = unwrap(Money.fromValue(100));

        const result = m1.greaterThan(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

    });

    describe('lessThan', () => {
      it('должен возвращать true когда меньше', () => {
        const m1 = unwrap(Money.fromValue(50));
        const m2 = unwrap(Money.fromValue(100));

        const result = m1.lessThan(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('должен возвращать false когда больше', () => {
        const m1 = unwrap(Money.fromValue(100));
        const m2 = unwrap(Money.fromValue(50));

        const result = m1.lessThan(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

    });

    describe('greaterThanOrEqual', () => {
      it('должен возвращать true когда больше', () => {
        const m1 = unwrap(Money.fromValue(100));
        const m2 = unwrap(Money.fromValue(50));

        const result = m1.greaterThanOrEqual(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('должен возвращать true когда равно', () => {
        const m1 = unwrap(Money.fromValue(100));
        const m2 = unwrap(Money.fromValue(100));

        const result = m1.greaterThanOrEqual(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('должен возвращать false когда меньше', () => {
        const m1 = unwrap(Money.fromValue(50));
        const m2 = unwrap(Money.fromValue(100));

        const result = m1.greaterThanOrEqual(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

    });

    describe('lessThanOrEqual', () => {
      it('должен возвращать true когда меньше', () => {
        const m1 = unwrap(Money.fromValue(50));
        const m2 = unwrap(Money.fromValue(100));

        const result = m1.lessThanOrEqual(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('должен возвращать true когда равно', () => {
        const m1 = unwrap(Money.fromValue(100));
        const m2 = unwrap(Money.fromValue(100));

        const result = m1.lessThanOrEqual(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('должен возвращать false когда больше', () => {
        const m1 = unwrap(Money.fromValue(100));
        const m2 = unwrap(Money.fromValue(50));

        const result = m1.lessThanOrEqual(m2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

    });
  });

  describe('Утилиты', () => {
    describe('isZero', () => {
      it('должен возвращать true для нуля', () => {
        const zero = Money.zero();

        expect(zero.isZero()).toBe(true);
      });

      it('должен возвращать false для ненулевого', () => {
        const money = unwrap(Money.fromValue(100));

        expect(money.isZero()).toBe(false);
      });

      it('должен возвращать false для отрицательного', () => {
        const money = unwrap(Money.fromValue(-50));

        expect(money.isZero()).toBe(false);
      });
    });

    describe('isPositive', () => {
      it('должен возвращать true для положительного', () => {
        const money = unwrap(Money.fromValue(100));

        expect(money.isPositive()).toBe(true);
      });

      it('должен возвращать false для нуля', () => {
        const zero = Money.zero();

        expect(zero.isPositive()).toBe(false);
      });

      it('должен возвращать false для отрицательного', () => {
        const money = unwrap(Money.fromValue(-50));

        expect(money.isPositive()).toBe(false);
      });
    });

    describe('isNegative', () => {
      it('должен возвращать true для отрицательного', () => {
        const money = unwrap(Money.fromValue(-50));

        expect(money.isNegative()).toBe(true);
      });

      it('должен возвращать false для нуля', () => {
        const zero = Money.zero();

        expect(zero.isNegative()).toBe(false);
      });

      it('должен возвращать false для положительного', () => {
        const money = unwrap(Money.fromValue(100));

        expect(money.isNegative()).toBe(false);
      });
    });

    describe('abs', () => {
      it('должен возвращать абсолютное значение положительного', () => {
        const money = unwrap(Money.fromValue(100));
        const abs = money.abs();

        expect(abs.getAmount()).toBe(100);
      });

      it('должен возвращать абсолютное значение отрицательного', () => {
        const money = unwrap(Money.fromValue(-50));
        const abs = money.abs();

        expect(abs.getAmount()).toBe(50);
      });

      it('должен возвращать ноль для нуля', () => {
        const zero = Money.zero();
        const abs = zero.abs();

        expect(abs.isZero()).toBe(true);
      });

      it('не должен изменять оригинал', () => {
        const money = unwrap(Money.fromValue(-50));
        money.abs();

        expect(money.getAmount()).toBe(-50);
      });
    });

    describe('negate', () => {
      it('должен инвертировать положительное', () => {
        const money = unwrap(Money.fromValue(100));
        const negated = money.negate();

        expect(negated.getAmount()).toBe(-100);
      });

      it('должен инвертировать отрицательное', () => {
        const money = unwrap(Money.fromValue(-50));
        const negated = money.negate();

        expect(negated.getAmount()).toBe(50);
      });

      it('должен инвертировать ноль', () => {
        const zero = Money.zero();
        const negated = zero.negate();

        expect(negated.isZero()).toBe(true);
      });

      it('не должен изменять оригинал', () => {
        const money = unwrap(Money.fromValue(100));
        money.negate();

        expect(money.getAmount()).toBe(100);
      });
    });

    describe('toString', () => {
      it('должен форматировать с десятичными знаками по умолчанию', () => {
        const money = unwrap(Money.fromValue(100.5));

        expect(money.toString()).toBe('$100.50 USDC');
      });

      it('должен форматировать с указанным количеством знаков', () => {
        const money = unwrap(Money.fromValue(100.5));

        expect(money.toString(4)).toBe('$100.5000 USDC');
      });

      it('должен форматировать отрицательные суммы', () => {
        const money = unwrap(Money.fromValue(-50.25));

        expect(money.toString()).toBe('$-50.25 USDC');
      });

      it('должен форматировать ноль', () => {
        const zero = Money.zero();

        expect(zero.toString()).toBe('$0.00 USDC');
      });
    });
  });

  describe('Граничные случаи', () => {
    describe('Точность Decimal', () => {
      it('должен корректно обрабатывать 0.1 + 0.2 = 0.3', () => {
        const m1 = unwrap(Money.fromValue('0.1'));
        const m2 = unwrap(Money.fromValue('0.2'));

        const result = m1.add(m2);

        // С decimal.js это точно 0.3, а не 0.30000000000000004
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('0.3');
        }
      });

      it('должен сохранять высокую точность', () => {
        const money = unwrap(Money.fromValue('100.123456789012345'));

        expect(money.toDecimal().toString()).toBe('100.123456789012345');
      });

      it('должен обрабатывать очень малые числа', () => {
        const money = unwrap(Money.fromValue('0.000001'));

        expect(money.toDecimal().toString()).toBe('0.000001');
      });
    });

    describe('Большие числа', () => {
      it('должен обрабатывать большие суммы', () => {
        const result = Money.fromValue(1e10);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getAmount()).toBe(1e10);
        }
      });

      it('должен обнаруживать переполнение при умножении', () => {
        const money = unwrap(Money.fromValue(1e15));
        const result = money.multiply(1000);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(ArithmeticOverflowError);
        }
      });
    });

    describe('Отрицательный ноль', () => {
      it('должен трактовать -0 как ноль', () => {
        const money = unwrap(Money.fromValue(-0));

        expect(money.isZero()).toBe(true);
      });
    });
  });

  describe('Сериализация', () => {
    describe('toJSON', () => {
      it('должен сериализовать Money в JSON', () => {
        const money = unwrap(Money.fromValue(100.5));
        const json = money.toJSON();

        expect(json).toEqual({ amount: '100.5', currency: 'USDC' });
      });

      it('должен сериализовать с другой валютой', () => {
        const money = unwrap(Money.fromValue(50));
        const json = money.toJSON();

        expect(json).toEqual({ amount: '50', currency: 'USDC' });
      });

      it('должен сериализовать ноль', () => {
        const json = Money.zero().toJSON();

        expect(json).toEqual({ amount: '0', currency: 'USDC' });
      });
    });

    describe('fromJSON', () => {
      it('должен десериализовать Money из JSON', () => {
        const json = { amount: '100.5', currency: 'USDC' as const };
        const result = Money.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getAmount()).toBe(100.5);
          expect(result.value.getCurrency()).toBe('USDC');
        }
      });

      it('должен отклонить невалидную сумму', () => {
        const json = { amount: 'invalid', currency: 'USDC' as const };
        const result = Money.fromJSON(json);

        expect(result.ok).toBe(false);
      });

      it('должен корректно работать round-trip', () => {
        const original = unwrap(Money.fromValue(123.456));
        const json = original.toJSON();
        const deserialized = unwrap(Money.fromJSON(json));

        expect(deserialized.equals(original)).toBe(true);
      });
    });
  });
});
import { describe, it, expect, jest } from '@jest/globals';
import { QuantityService } from '../../../../src/quantity/facade/QuantityService.js';
import { Quantity } from '../../../../src/quantity/core/Quantity.js';
import { InvalidQuantityError, DivisionByZeroError, ArithmeticOverflowError, InvalidOperandError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import * as math from '@polymarket/math';

describe('QuantityService', () => {
  describe('create()', () => {
    it('должен создать Quantity из number', () => {
      const result = QuantityService.create(10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeInstanceOf(Quantity);
        expect(result.value.value().toNumber()).toBe(10);
      }
    });

    it('должен создать Quantity из string', () => {
      const result = QuantityService.create("15.5");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe("15.5");
      }
    });

    it('должен создать Quantity из Decimal', () => {
      const decimal = new Decimal(20);
      const result = QuantityService.create(decimal);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Проверяем что значение корректно создано из Decimal
        expect(result.value.value().toNumber()).toBe(20);
      }
    });

    it('должен вернуть Err для negative', () => {
      const result = QuantityService.create(-1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
      }
    });

    it('должен вернуть Err для NaN', () => {
      const result = QuantityService.create(NaN);
      expect(result.ok).toBe(false);
    });

    it('должен вернуть Err для Infinity', () => {
      const result = QuantityService.create(Infinity);
      expect(result.ok).toBe(false);
    });

    describe('Facade Error Contract', () => {
      it('error должен содержать context.op = "create"', () => {
        expect.assertions(1);
        const result = QuantityService.create(-1);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('create');
        }
      });

      it('error должен содержать context.raw.value', () => {
        expect.assertions(1);
        const result = QuantityService.create(-1);
        if (!result.ok) {
          expect(result.error.context?.raw).toEqual({ field: 'value', value: '-1' });
        }
      });

      it('error должен содержать context.reason (от QuantityInvariantViolation)', () => {
        expect.assertions(1);
        const result = QuantityService.create(-1);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe('NEGATIVE');
        }
      });

      it('error для Infinity должен иметь reason = NON_FINITE', () => {
        expect.assertions(1);
        const result = QuantityService.create(Infinity);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe('NON_FINITE');
        }
      });

      it('должен обработать unexpected error из Quantity.fromDecimal', () => {
        // Mock Quantity.fromDecimal to throw unexpected error
        const spy = jest.spyOn(Quantity, 'fromDecimal').mockImplementation(() => {
          throw new Error('unexpected error from Quantity.fromDecimal');
        });

        try {
          const result = QuantityService.create(10);

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.message).toContain('Unexpected error during quantity create');
            expect(result.error.context?.op).toBe('create');
          }
        } finally {
          spy.mockRestore();
        }
      });
    });

    describe('toDecimal helper', () => {
      it('должен обработать invalid string при парсинге через multiply', () => {
        const qty = Quantity.of(10);
        // Передаём невалидное значение через multiply, что вызовет toDecimal
        const result = QuantityService.multiply(qty, 'invalid' as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Invalid argument');
          expect(result.error.context?.op).toBe('multiply');
          expect(result.error.context?.factor).toBe('invalid');  // rewrap добавляет factor
          expect(result.error.context?.raw).toEqual({ field: 'factor', value: 'invalid' }); // toDecimal добавляет структурированный raw
          expect(result.error.context?.cause).toBeDefined();
        }
      });

      it('должен обработать invalid string при парсинге через divide', () => {
        const qty = Quantity.of(10);
        const result = QuantityService.divide(qty, 'abc' as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Invalid argument');
          expect(result.error.context?.op).toBe('divide');
          expect(result.error.context?.divisor).toBe('abc');  // rewrap добавляет divisor
          expect(result.error.context?.raw).toEqual({ field: 'divisor', value: 'abc' }); // toDecimal добавляет структурированный raw
          expect(result.error.context?.cause).toBeDefined();
        }
      });

      it('должен обработать invalid string при парсинге через roundToStep', () => {
        const qty = Quantity.of(10);
        const result = QuantityService.roundToStep(qty, 'xyz' as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Invalid argument');
          expect(result.error.context?.op).toBe('roundToStep');
          expect(result.error.context?.stepSize).toBe('xyz');  // rewrap добавляет stepSize
          expect(result.error.context?.raw).toEqual({ field: 'stepSize', value: 'xyz' }); // toDecimal добавляет структурированный raw
          expect(result.error.context?.cause).toBeDefined();
        }
      });
    });
  });

  describe('add()', () => {
    it('должен сложить два Quantity', () => {
      const qty1 = Quantity.of(10);
      const qty2 = Quantity.of(5);
      const result = QuantityService.add(qty1, qty2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(15);
      }
    });

    it('должен работать с ZERO', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.add(qty, Quantity.ZERO);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(10);
      }
    });

    it('должен вернуть Err если результат сложения non-finite', () => {
      // Mock addDecimal to return Infinity
      jest.spyOn(math, 'addDecimal').mockReturnValue(new Decimal(Infinity));

      const qty1 = Quantity.of(10);
      const qty2 = Quantity.of(5);
      const result = QuantityService.add(qty1, qty2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('add');
        expect(result.error.context?.reason).toBe('NON_FINITE');
      }

      jest.restoreAllMocks();
    });

    // Примечание: Decimal.js не производит Infinity при арифметических операциях,
    // так как работает с arbitrary precision. Overflow проверяется при создании
    // Quantity из результатов math операций, если математическая библиотека
    // вернёт non-finite значение (что маловероятно с Decimal.js).
    // Этот тест оставлен закомментированным как документация expected behavior.

    // it('должен вернуть Err если результат non-finite (overflow)', () => {
    //   // В реальности Decimal.js не даёт Infinity при add()
    //   // Overflow может произойти только если math layer вернёт Infinity
    //   const result = QuantityService.add(bigQty, bigQty);
    //   expect(result.ok).toBe(false);
    //   if (!result.ok) {
    //     expect(result.error).toBeInstanceOf(InvalidQuantityError);
    //     expect(result.error.context?.reason).toBe('NON_FINITE');
    //   }
    // });

    // Примечание: Тесты Facade Error Contract закомментированы, так как
    // Decimal.js не производит overflow/Infinity для add() (arbitrary precision).
    // Error contract задокументирован, но реально протестировать его для add()
    // невозможно с валидными Quantity объектами.

    // describe('Facade Error Contract', () => {
    //   it('error должен содержать context.op = "add"', () => {
    //     // Decimal.js не даёт Infinity при сложении
    //     const bigQty = Quantity.fromDecimal(new Decimal('1e308'));
    //     const result = QuantityService.add(bigQty, bigQty);
    //
    //     if (!result.ok) {
    //       expect(result.error.context?.op).toBe('add');
    //     }
    //   });
    //
    //   it('error должен содержать context.quantity1 и quantity2', () => {
    //     // Decimal.js не даёт Infinity при сложении
    //     const bigQty = Quantity.fromDecimal(new Decimal('1e308'));
    //     const result = QuantityService.add(bigQty, bigQty);
    //
    //     if (!result.ok) {
    //       expect(result.error.context).toHaveProperty('quantity1');
    //       expect(result.error.context).toHaveProperty('quantity2');
    //     }
    //   });
    // });

    describe('Math exception handling', () => {
      it('должен ловить InvalidOperandError из @polymarket/math', () => {
        jest.spyOn(math, 'addDecimal').mockImplementation(() => {
          throw new InvalidOperandError(() => 'invalid operand', {
            context: {}
          });
        });

        const qty1 = Quantity.of(10);
        const qty2 = Quantity.of(5);
        const result = QuantityService.add(qty1, qty2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('add failed');
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string; stack?: string };
          expect(cause.name).toBe('InvalidOperandError');
        }

        jest.restoreAllMocks();
      });

      it('должен ловить ArithmeticOverflowError из @polymarket/math', () => {
        jest.spyOn(math, 'addDecimal').mockImplementation(() => {
          throw new ArithmeticOverflowError(() => 'overflow', {
            context: {}
          });
        });

        const qty1 = Quantity.of(10);
        const qty2 = Quantity.of(5);
        const result = QuantityService.add(qty1, qty2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('add failed');
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string; stack?: string };
          expect(cause.name).toBe('ArithmeticOverflowError');
        }

        jest.restoreAllMocks();
      });

      it('должен обернуть неожиданные ошибки в Result', () => {
        jest.spyOn(math, 'addDecimal').mockImplementation(() => {
          throw new Error('unexpected add error');
        });

        const qty1 = Quantity.of(10);
        const qty2 = Quantity.of(5);
        const result = QuantityService.add(qty1, qty2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Unexpected error during quantity add');
          expect(result.error.context?.cause).toBeDefined();
        }

        jest.restoreAllMocks();
      });

      it('должен обработать non-Error выброс из math', () => {
        jest.spyOn(math, 'addDecimal').mockImplementation(() => {
          throw 'string error'; // eslint-disable-line @typescript-eslint/only-throw-error
        });

        const qty1 = Quantity.of(10);
        const qty2 = Quantity.of(5);
        const result = QuantityService.add(qty1, qty2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          const cause = result.error.context?.cause as { name: string; message: string };
          expect(cause.name).toBe('UnknownError');
          expect(cause.message).toBe('string error');
        }

        jest.restoreAllMocks();
      });
    });
  });

  describe('subtract()', () => {
    it('должен вычесть два Quantity', () => {
      const qty1 = Quantity.of(10);
      const qty2 = Quantity.of(5);
      const result = QuantityService.subtract(qty1, qty2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(5);
      }
    });

    it('должен вернуть Ok для 0 результата', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.subtract(qty, qty);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(0);
      }
    });

    it('должен вернуть Err для negative результата', () => {
      const qty1 = Quantity.of(5);
      const qty2 = Quantity.of(10);
      const result = QuantityService.subtract(qty1, qty2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('cannot be negative');
      }
    });

    describe('Facade Error Contract', () => {
      it('error должен содержать context.op = "subtract"', () => {
        expect.assertions(1);
        const qty1 = Quantity.of(5);
        const qty2 = Quantity.of(10);
        const result = QuantityService.subtract(qty1, qty2);

        if (!result.ok) {
          expect(result.error.context?.op).toBe('subtract');
        }
      });

      it('error должен содержать context.quantity1 и quantity2', () => {
        expect.assertions(2);
        const qty1 = Quantity.of(5);
        const qty2 = Quantity.of(10);
        const result = QuantityService.subtract(qty1, qty2);

        if (!result.ok) {
          expect(result.error.context?.quantity1).toBe('5');
          expect(result.error.context?.quantity2).toBe('10');
        }
      });

      it('error должен содержать context.result (от rule)', () => {
        expect.assertions(2);
        const qty1 = Quantity.of(5);
        const qty2 = Quantity.of(10);
        const result = QuantityService.subtract(qty1, qty2);

        if (!result.ok) {
          expect(result.error.context).toHaveProperty('result');
          expect(result.error.context?.result).toBe('-5');
        }
      });
    });

    describe('Math exception handling', () => {
      it('должен ловить InvalidOperandError из @polymarket/math', () => {
        jest.spyOn(math, 'subtractDecimal').mockImplementation(() => {
          throw new InvalidOperandError(() => 'invalid operand', {
            context: {}
          });
        });

        const qty1 = Quantity.of(10);
        const qty2 = Quantity.of(5);
        const result = QuantityService.subtract(qty1, qty2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('subtract failed');
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string; stack?: string };
          expect(cause.name).toBe('InvalidOperandError');
        }

        jest.restoreAllMocks();
      });

      it('должен ловить ArithmeticOverflowError из @polymarket/math', () => {
        jest.spyOn(math, 'subtractDecimal').mockImplementation(() => {
          throw new ArithmeticOverflowError(() => 'overflow', {
            context: {}
          });
        });

        const qty1 = Quantity.of(10);
        const qty2 = Quantity.of(5);
        const result = QuantityService.subtract(qty1, qty2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('subtract failed');
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string; stack?: string };
          expect(cause.name).toBe('ArithmeticOverflowError');
        }

        jest.restoreAllMocks();
      });

      it('должен обернуть неожиданные ошибки в Result', () => {
        jest.spyOn(math, 'subtractDecimal').mockImplementation(() => {
          throw new Error('unexpected subtract error');
        });

        const qty1 = Quantity.of(10);
        const qty2 = Quantity.of(5);
        const result = QuantityService.subtract(qty1, qty2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Unexpected error during quantity subtract');
        }

        jest.restoreAllMocks();
      });

      it('должен вернуть Err если результат вычитания non-finite', () => {
        // Mock subtractDecimal to return NaN (which is non-finite)
        jest.spyOn(math, 'subtractDecimal').mockReturnValue(new Decimal(NaN));

        const qty1 = Quantity.of(10);
        const qty2 = Quantity.of(5);
        const result = QuantityService.subtract(qty1, qty2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('subtract');
          // Verify create failed after math operation
          expect(result.error).toBeInstanceOf(InvalidQuantityError);
        }

        jest.restoreAllMocks();
      });
    });
  });

  describe('multiply()', () => {
    it('должен умножить Quantity на number', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.multiply(qty, 2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(20);
      }
    });

    it('должен умножить Quantity на Decimal', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.multiply(qty, new Decimal(2.5));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(25);
      }
    });

    it('должен вернуть Ok для умножения на 0', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.multiply(qty, 0);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(0);
      }
    });

    it('должен вернуть Err для negative factor', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.multiply(qty, -1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('cannot be negative');
      }
    });

    it('должен вернуть Err для Infinity factor', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.multiply(qty, Infinity);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be finite');
      }
    });

    it('должен вернуть Err если результат умножения Infinity', () => {
      // Mock multiplyDecimal to return Infinity
      jest.spyOn(math, 'multiplyDecimal').mockReturnValue(new Decimal(Infinity));

      const qty = Quantity.of(10);
      const result = QuantityService.multiply(qty, 2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('multiply');
        expect(result.error.context?.reason).toBe('NON_FINITE');
      }

      jest.restoreAllMocks();
    });

    describe('Facade Error Contract', () => {
      it('error должен содержать context.op = "multiply"', () => {
        expect.assertions(1);
        const qty = Quantity.of(10);
        const result = QuantityService.multiply(qty, -1);

        if (!result.ok) {
          expect(result.error.context?.op).toBe('multiply');
        }
      });

      it('error должен содержать context.quantity', () => {
        expect.assertions(1);
        const qty = Quantity.of(10);
        const result = QuantityService.multiply(qty, -1);

        if (!result.ok) {
          expect(result.error.context?.quantity).toBe('10');
        }
      });

      it('error должен содержать context.factor', () => {
        expect.assertions(1);
        const qty = Quantity.of(10);
        const result = QuantityService.multiply(qty, -1);

        if (!result.ok) {
          expect(result.error.context?.factor).toBe('-1');
        }
      });
    });

    describe('Math exception handling', () => {
      it('должен ловить InvalidOperandError из @polymarket/math', () => {
        jest.spyOn(math, 'multiplyDecimal').mockImplementation(() => {
          throw new InvalidOperandError(() => 'invalid operand', {
            context: {}
          });
        });

        const qty = Quantity.of(10);
        const result = QuantityService.multiply(qty, 2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('multiply failed');
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string; stack?: string };
          expect(cause.name).toBe('InvalidOperandError');
        }

        jest.restoreAllMocks();
      });

      it('должен ловить ArithmeticOverflowError из @polymarket/math', () => {
        jest.spyOn(math, 'multiplyDecimal').mockImplementation(() => {
          throw new ArithmeticOverflowError(() => 'overflow', {
            context: {}
          });
        });

        const qty = Quantity.of(10);
        const result = QuantityService.multiply(qty, 2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('multiply failed');
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string; stack?: string };
          expect(cause.name).toBe('ArithmeticOverflowError');
        }

        jest.restoreAllMocks();
      });

      it('должен обернуть неожиданные ошибки в Result', () => {
        jest.spyOn(math, 'multiplyDecimal').mockImplementation(() => {
          throw new Error('unexpected multiply error');
        });

        const qty = Quantity.of(10);
        const result = QuantityService.multiply(qty, 2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Unexpected error during quantity multiply');
        }

        jest.restoreAllMocks();
      });
    });
  });

  describe('divide()', () => {
    it('должен разделить Quantity на number', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.divide(qty, 2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(5);
      }
    });

    it('должен разделить Quantity на Decimal', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.divide(qty, new Decimal(2));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(5);
      }
    });

    it('должен вернуть Err для division by zero', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.divide(qty, 0);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        // Может быть от rule (divisor > 0) или от math (DivisionByZeroError)
      }
    });

    it('должен вернуть Err для negative divisor', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.divide(qty, -1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be positive');
      }
    });

    it('должен вернуть Err для Infinity divisor', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.divide(qty, Infinity);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be finite');
      }
    });

    it('должен вернуть Err если результат деления non-finite', () => {
      // Mock divideDecimal to return NaN (which is non-finite)
      const mockFn = jest.spyOn(math, 'divideDecimal').mockReturnValue(new Decimal(NaN));

      const qty = Quantity.of(10);
      const result = QuantityService.divide(qty, 2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('divide');
        // NaN is now explicitly checked with NAN reason
        expect(result.error.context?.reason).toBe('NAN');
      }

      mockFn.mockRestore();
    });

    describe('Math exception handling', () => {
      it('должен ловить DivisionByZeroError из @polymarket/math', () => {
        // Mock divideDecimal чтобы бросить DivisionByZeroError
        jest.spyOn(math, 'divideDecimal').mockImplementation(() => {
          throw new DivisionByZeroError(() => 'division by zero', {
            context: {}
          });
        });

        const qty = Quantity.of(10);
        const result = QuantityService.divide(qty, 1); // divisor valid, но divideDecimal бросит

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('divide failed');
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string; stack?: string };
          expect(cause.name).toBe('DivisionByZeroError');
          expect(cause.message).toBe('division by zero');
        }

        // Restore
        jest.restoreAllMocks();
      });

      it('должен ловить ArithmeticOverflowError из @polymarket/math', () => {
        jest.spyOn(math, 'divideDecimal').mockImplementation(() => {
          throw new ArithmeticOverflowError(() => 'overflow', {
            context: {}
          });
        });

        const qty = Quantity.of(10);
        const result = QuantityService.divide(qty, 1);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string; stack?: string };
          expect(cause.name).toBe('ArithmeticOverflowError');
          expect(cause.message).toBe('overflow');
        }

        jest.restoreAllMocks();
      });

      it('должен обернуть неожиданные ошибки в Result', () => {
        expect.assertions(7);
        jest.spyOn(math, 'divideDecimal').mockImplementation(() => {
          throw new Error('unexpected error');
        });

        const qty = Quantity.of(10);
        const result = QuantityService.divide(qty, 1);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Unexpected error during quantity divide');
          expect(result.error.context?.op).toBe('divide');
          expect(result.error.context?.cause).toBeDefined();
          expect(result.error.context?.cause).toHaveProperty('name', 'Error');
          expect(result.error.context?.cause).toHaveProperty('message', 'unexpected error');
          expect(result.error.context?.cause).toHaveProperty('stack');
        }

        jest.restoreAllMocks();
      });
    });

    describe('Facade Error Contract', () => {
      it('error должен содержать context.op = "divide"', () => {
        expect.assertions(1);
        const qty = Quantity.of(10);
        const result = QuantityService.divide(qty, 0);

        if (!result.ok) {
          expect(result.error.context?.op).toBe('divide');
        }
      });

      it('error должен содержать context.quantity и divisor', () => {
        expect.assertions(2);
        const qty = Quantity.of(10);
        const result = QuantityService.divide(qty, 0);

        if (!result.ok) {
          expect(result.error.context?.quantity).toBe('10');
          expect(result.error.context).toHaveProperty('divisor');
        }
      });

      it('error для math exception должен содержать context.cause', () => {
        jest.spyOn(math, 'divideDecimal').mockImplementation(() => {
          throw new DivisionByZeroError(() => 'test', {
            context: {}
          });
        });

        const qty = Quantity.of(10);
        const result = QuantityService.divide(qty, 1);

        if (!result.ok) {
          expect(result.error.context).toHaveProperty('cause');
          expect(result.error.context?.cause).toHaveProperty('name');
          expect(result.error.context?.cause).toHaveProperty('message');
        }

        jest.restoreAllMocks();
      });
    });
  });

  describe('roundToStep()', () => {
    it('должен округлить Quantity до step', () => {
      const qty = Quantity.of(10.567);
      const result = QuantityService.roundToStep(qty, new Decimal(0.01));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(10.57);
      }
    });

    it('должен работать с разными rounding modes', () => {
      const qty = Quantity.of(10.555);
      const result = QuantityService.roundToStep(
        qty,
        new Decimal(0.01),
        Decimal.ROUND_DOWN
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(10.55);
      }
    });

    it('должен вернуть Err для stepSize <= 0', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.roundToStep(qty, new Decimal(0));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be positive');
      }
    });

    it('должен вернуть Err для Infinity stepSize', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.roundToStep(qty, new Decimal(Infinity));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be finite');
      }
    });

    it('должен вернуть Err если результат roundToStep Infinity', () => {
      // Mock roundToTick to return Infinity
      jest.spyOn(math, 'roundToTick').mockReturnValue(new Decimal(Infinity));

      const qty = Quantity.of(10);
      const result = QuantityService.roundToStep(qty, new Decimal(0.1));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('roundToStep');
        expect(result.error.context?.reason).toBe('NON_FINITE');
      }

      jest.restoreAllMocks();
    });

    describe('Facade Error Contract', () => {
      it('error должен содержать context.op = "roundToStep"', () => {
        expect.assertions(1);
        const qty = Quantity.of(10);
        const result = QuantityService.roundToStep(qty, new Decimal(0));

        if (!result.ok) {
          expect(result.error.context?.op).toBe('roundToStep');
        }
      });

      it('error должен содержать context.quantity и stepSize', () => {
        expect.assertions(2);
        const qty = Quantity.of(10);
        const result = QuantityService.roundToStep(qty, new Decimal(0));

        if (!result.ok) {
          expect(result.error.context?.quantity).toBe('10');
          expect(result.error.context?.stepSize).toBe('0');
        }
      });
    });

    describe('Math exception handling', () => {
      it('должен ловить InvalidOperandError из @polymarket/math', () => {
        jest.spyOn(math, 'roundToTick').mockImplementation(() => {
          throw new InvalidOperandError(() => 'invalid operand', {
            context: {}
          });
        });

        const qty = Quantity.of(10);
        const result = QuantityService.roundToStep(qty, new Decimal(0.1));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('roundToStep failed');
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string; stack?: string };
          expect(cause.name).toBe('InvalidOperandError');
        }

        jest.restoreAllMocks();
      });

      it('должен ловить ArithmeticOverflowError из @polymarket/math', () => {
        jest.spyOn(math, 'roundToTick').mockImplementation(() => {
          throw new ArithmeticOverflowError(() => 'overflow', {
            context: {}
          });
        });

        const qty = Quantity.of(10);
        const result = QuantityService.roundToStep(qty, new Decimal(0.1));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('roundToStep failed');
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string; stack?: string };
          expect(cause.name).toBe('ArithmeticOverflowError');
        }

        jest.restoreAllMocks();
      });

      it('должен обернуть неожиданные ошибки в Result', () => {
        jest.spyOn(math, 'roundToTick').mockImplementation(() => {
          throw new Error('unexpected roundToStep error');
        });

        const qty = Quantity.of(10);
        const result = QuantityService.roundToStep(qty, new Decimal(0.1));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Unexpected error during quantity roundToStep');
        }

        jest.restoreAllMocks();
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // COMPREHENSIVE ERROR CONTRACT TESTS
  // ═══════════════════════════════════════════════════════════════════════
  describe('Facade Error Contract - Comprehensive', () => {
    describe('Parse fail → context.op и context.raw обязательны', () => {
      it('create: parse fail должен содержать op и raw', () => {
        const result = QuantityService.create('invalid' as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('create');
          expect(result.error.context?.raw).toBeDefined();
          expect(result.error.context?.cause).toBeDefined();
        }
      });

      it('multiply: parse fail должен содержать op, raw и factor', () => {
        const qty = Quantity.of(10);
        const result = QuantityService.multiply(qty, 'invalid' as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('multiply');
          expect(result.error.context?.raw).toBeDefined();
          expect(result.error.context?.factor).toBeDefined();
          expect(result.error.context?.cause).toBeDefined();
        }
      });

      it('divide: parse fail должен содержать op, raw и divisor', () => {
        const qty = Quantity.of(10);
        const result = QuantityService.divide(qty, 'invalid' as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('divide');
          expect(result.error.context?.raw).toBeDefined();
          expect(result.error.context?.divisor).toBeDefined();
          expect(result.error.context?.cause).toBeDefined();
        }
      });

      it('roundToStep: parse fail должен содержать op, raw и stepSize', () => {
        const qty = Quantity.of(10);
        const result = QuantityService.roundToStep(qty, 'invalid' as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('roundToStep');
          expect(result.error.context?.raw).toBeDefined();
          expect(result.error.context?.stepSize).toBeDefined();
          expect(result.error.context?.cause).toBeDefined();
        }
      });
    });

    describe('Rule fail → op и операционные поля обязательны', () => {
      it('subtract: rule fail должен содержать op и операционные поля', () => {
        const qty1 = Quantity.of(5);
        const qty2 = Quantity.of(10);
        const result = QuantityService.subtract(qty1, qty2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('subtract');
          expect(result.error.context?.quantity1).toBeDefined();
          expect(result.error.context?.quantity2).toBeDefined();
          expect(result.error.context?.result).toBeDefined();
        }
      });

      it('multiply: rule fail должен содержать op и операционные поля', () => {
        const qty = Quantity.of(10);
        const result = QuantityService.multiply(qty, -1);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('multiply');
          expect(result.error.context?.quantity).toBeDefined();
          expect(result.error.context?.factor).toBeDefined();
        }
      });

      it('divide: rule fail должен содержать op и операционные поля', () => {
        const qty = Quantity.of(10);
        const result = QuantityService.divide(qty, 0);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('divide');
          expect(result.error.context?.quantity).toBeDefined();
          expect(result.error.context?.divisor).toBeDefined();
        }
      });

      it('roundToStep: rule fail должен содержать op и операционные поля', () => {
        const qty = Quantity.of(10);
        const result = QuantityService.roundToStep(qty, new Decimal(0));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('roundToStep');
          expect(result.error.context?.quantity).toBeDefined();
          expect(result.error.context?.stepSize).toBeDefined();
        }
      });
    });

    describe('Math throw → cause.name и cause.message обязательны', () => {
      it('add: math exception должен содержать cause.name и cause.message', () => {
        jest.spyOn(math, 'addDecimal').mockImplementation(() => {
          throw new ArithmeticOverflowError(() => 'overflow', { context: {} });
        });

        const qty1 = Quantity.of(10);
        const qty2 = Quantity.of(5);
        const result = QuantityService.add(qty1, qty2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('add');
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string };
          expect(cause.name).toBeDefined();
          expect(cause.message).toBeDefined();
        }

        jest.restoreAllMocks();
      });

      it('divide: math exception должен содержать cause.name и cause.message', () => {
        jest.spyOn(math, 'divideDecimal').mockImplementation(() => {
          throw new DivisionByZeroError(() => 'division by zero', { context: {} });
        });

        const qty = Quantity.of(10);
        const result = QuantityService.divide(qty, 1);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('divide');
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string };
          expect(cause.name).toBe('DivisionByZeroError');
          expect(cause.message).toBe('division by zero');
        }

        jest.restoreAllMocks();
      });

      it('unexpected error: должен содержать cause даже для non-Error', () => {
        jest.spyOn(math, 'multiplyDecimal').mockImplementation(() => {
          throw 'string error'; // eslint-disable-line @typescript-eslint/only-throw-error
        });

        const qty = Quantity.of(10);
        const result = QuantityService.multiply(qty, 2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('multiply');
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string };
          expect(cause.name).toBe('UnknownError');
          expect(cause.message).toBe('string error');
        }

        jest.restoreAllMocks();
      });
    });

    describe('Контракт "Never Throw" - никогда не бросает исключения', () => {
      it('create: всегда возвращает Result, никогда не throw', () => {
        expect(() => QuantityService.create(NaN)).not.toThrow();
        expect(() => QuantityService.create(Infinity)).not.toThrow();
        expect(() => QuantityService.create(-1)).not.toThrow();
        expect(() => QuantityService.create('invalid' as any)).not.toThrow();
      });

      it('операции: всегда возвращают Result, никогда не throw', () => {
        const qty = Quantity.of(10);
        expect(() => QuantityService.add(qty, qty)).not.toThrow();
        expect(() => QuantityService.multiply(qty, -1)).not.toThrow();
        expect(() => QuantityService.divide(qty, 0)).not.toThrow();
        expect(() => QuantityService.roundToStep(qty, new Decimal(0))).not.toThrow();
      });
    });
  });
});

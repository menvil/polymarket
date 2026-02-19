import Decimal from 'decimal.js';
import { Money } from '../../../../src/money/core/Money';
import { MoneySerializer } from '../../../../src/money/adapters/MoneySerializer';
import { InvalidMoneyError } from '@polymarket/errors';

describe('MoneySerializer', () => {
  describe('toJSON', () => {
    it('сериализует Money в JSON', () => {
      const money = Money.of(new Decimal(100.50));
      const json = MoneySerializer.toJSON(money);

      expect(json).toEqual({
        amount: '100.5',
        currency: 'USDC',
      });
    });

    it('сохраняет точность для больших чисел', () => {
      const money = Money.of(new Decimal('999999999999.123456789'));
      const json = MoneySerializer.toJSON(money);

      expect(json.amount).toBe('999999999999.123456789');
    });

    it('сериализует отрицательные суммы', () => {
      const money = Money.of(new Decimal(-100));
      const json = MoneySerializer.toJSON(money);

      expect(json.amount).toBe('-100');
    });

    it('сериализует ноль', () => {
      const money = Money.ZERO.USDC;
      const json = MoneySerializer.toJSON(money);

      expect(json.amount).toBe('0');
      expect(json.currency).toBe('USDC');
    });
  });

  describe('fromJSON', () => {
    describe('success', () => {
      it('десериализует из валидного JSON с number', () => {
        const result = MoneySerializer.fromJSON({ amount: 100, currency: 'USDC' });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value().toNumber()).toBe(100);
          expect(result.value.currency()).toBe('USDC');
        }
      });

      it('десериализует из валидного JSON с string', () => {
        const result = MoneySerializer.fromJSON({ amount: '100.50', currency: 'USDC' });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value().equals(new Decimal('100.5'))).toBe(true);
        }
      });

      it('сохраняет точность при десериализации', () => {
        const result = MoneySerializer.fromJSON({
          amount: '999999999999.123456789',
          currency: 'USDC',
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value().toString()).toBe('999999999999.123456789');
        }
      });
    });

    describe('validation errors', () => {
      it('отклоняет null', () => {
        const result = MoneySerializer.fromJSON(null);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidMoneyError);
          expect(result.error.context!.reason).toBe('INVALID_FORMAT');
        }
      });

      it('отклоняет array', () => {
        const result = MoneySerializer.fromJSON([100, 'USDC']);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context!.reason).toBe('INVALID_FORMAT');
        }
      });

      it('отклоняет primitive', () => {
        const result = MoneySerializer.fromJSON(100);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context!.reason).toBe('INVALID_FORMAT');
        }
      });

      it('отклоняет объект без amount', () => {
        const result = MoneySerializer.fromJSON({ currency: 'USDC' });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context!.reason).toBe('INVALID_FORMAT');
        }
      });

      it('отклоняет объект без currency', () => {
        const result = MoneySerializer.fromJSON({ amount: 100 });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context!.reason).toBe('INVALID_FORMAT');
        }
      });

      it('отклоняет невалидный тип amount', () => {
        const result = MoneySerializer.fromJSON({ amount: null, currency: 'USDC' });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context!.reason).toBe('INVALID_FORMAT');
        }
      });

      it('отклоняет невалидный тип currency', () => {
        const result = MoneySerializer.fromJSON({ amount: 100, currency: 123 });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context!.reason).toBe('INVALID_FORMAT');
        }
      });
    });

    describe('business validation', () => {
      it('делегирует бизнес-валидацию MoneyService', () => {
        const result = MoneySerializer.fromJSON({ amount: NaN, currency: 'USDC' });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context!.reason).toBe('NAN');
        }
      });

      it('отклоняет превышение MAX_AMOUNT', () => {
        const result = MoneySerializer.fromJSON({ amount: '1e16', currency: 'USDC' });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context!.reason).toBe('EXCEEDS_MAX_AMOUNT');
        }
      });
    });
  });

  describe('roundtrip', () => {
    it('сохраняет данные при сериализации и десериализации', () => {
      const original = Money.of(new Decimal('123.456789'));
      const json = MoneySerializer.toJSON(original);
      const result = MoneySerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().equals(original.value())).toBe(true);
        expect(result.value.currency()).toBe(original.currency());
      }
    });
  });

  describe('safeStringify edge cases', () => {
    it('обрабатывает циклические ссылки в error context', () => {
      // Создаём объект с циклической ссылкой внутри amount
      const circular: any = { foo: 'bar' };
      circular.self = circular;

      const invalidJson = {
        amount: circular, // amount - объект с циклической ссылкой
        currency: 'USDC',
      };

      const result = MoneySerializer.fromJSON(invalidJson);

      // fromJSON должен вернуть ошибку, т.к. amount не number и не string
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Проверяем что error.context содержит amount без краша
        expect(result.error.context).toBeDefined();
        // safeStringify должен был обработать циклическую ссылку в amount
        expect(result.error.context?.amount).toContain('[Circular]');
      }
    });

    it('обрабатывает unstringifiable значения в error context', () => {
      // BigInt - это пример значения, которое JSON.stringify не поддерживает
      const invalidJson = {
        amount: BigInt(9007199254740991), // amount - BigInt (unstringifiable)
        currency: 'USDC',
      };

      const result = MoneySerializer.fromJSON(invalidJson);

      // fromJSON должен вернуть ошибку, т.к. amount не number и не string
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context).toBeDefined();
        // safeStringify должен был вернуть [Unstringifiable] для BigInt
        expect(result.error.context?.amount).toBe('[Unstringifiable]');
      }
    });
  });
});

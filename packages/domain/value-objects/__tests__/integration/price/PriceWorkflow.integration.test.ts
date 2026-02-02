import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { PriceService } from '../../../src/price/facade/PriceService.js';
import { ValidateAligned } from '../../../src/price/rules/ValidateAligned.js';
import { PriceSerializer } from '../../../src/price/adapters/PriceSerializer.js';
import { Price } from '../../../src/price/core/Price.js';

describe('Price Integration Tests', () => {
  describe('roundToMarketTick → ValidateAligned контракт', () => {
    it('результат roundToMarketTick всегда проходит ensureAlignedToMarketTick', () => {
      const price = Price.of(0.12345);
      const tickSize = 0.001;

      const roundResult = PriceService.roundToMarketTick(price, tickSize);
      expect(roundResult.ok).toBe(true);

      if (roundResult.ok) {
        const alignResult = PriceService.ensureAlignedToMarketTick(roundResult.value, tickSize);
        expect(alignResult.ok).toBe(true);
      }
    });

    it('работает для всех режимов округления', () => {
      const price = Price.of(0.5555);
      const tickSize = 0.01;

      for (const mode of ['nearest', 'floor', 'ceil'] as const) {
        const roundResult = PriceService.roundToMarketTick(price, tickSize, mode);
        expect(roundResult.ok).toBe(true);

        if (roundResult.ok) {
          const alignResult = ValidateAligned.check(roundResult.value, new Decimal(tickSize));
          expect(alignResult.ok).toBe(true);
        }
      }
    });

    it('работает с разными tickSize', () => {
      const price = Price.of(0.6789);
      const tickSizes = [0.0001, 0.001, 0.01, 0.1];

      for (const tickSize of tickSizes) {
        const roundResult = PriceService.roundToMarketTick(price, tickSize);
        expect(roundResult.ok).toBe(true);

        if (roundResult.ok) {
          const alignResult = ValidateAligned.check(roundResult.value, new Decimal(tickSize));
          expect(alignResult.ok).toBe(true);
        }
      }
    });
  });

  describe('Serialization round-trip', () => {
    it('fromJSON → toJSON сохраняет значение', () => {
      const original = { value: 0.5 };
      const deserResult = PriceSerializer.fromJSON(original);
      expect(deserResult.ok).toBe(true);

      if (deserResult.ok) {
        const serialized = PriceSerializer.toJSON(deserResult.value);
        expect(serialized.value).toBe('0.5');

        const deserResult2 = PriceSerializer.fromJSON(serialized);
        expect(deserResult2.ok).toBe(true);
        if (deserResult2.ok) {
          expect(deserResult2.value.equals(deserResult.value)).toBe(true);
        }
      }
    });

    it('сохраняет точность Decimal через string serialization', () => {
      const original = { value: '0.123456789' };
      const deserResult = PriceSerializer.fromJSON(original);
      expect(deserResult.ok).toBe(true);

      if (deserResult.ok) {
        const serialized = PriceSerializer.toJSON(deserResult.value);
        expect(serialized.value).toBe('0.123456789');
      }
    });
  });

  describe('Полный workflow: создание → операции → округление → валидация', () => {
    it('создание bid/ask с округлением', () => {
      // Шаг 1: Получаем сырые данные
      const rawBid = 0.5234;
      const rawAsk = 0.5789;
      const tickSize = 0.01;

      // Шаг 2: Создаём Price
      const bidResult = PriceService.create(rawBid);
      const askResult = PriceService.create(rawAsk);
      expect(bidResult.ok).toBe(true);
      expect(askResult.ok).toBe(true);

      if (bidResult.ok && askResult.ok) {
        // Шаг 3: Округляем
        const roundedBidResult = PriceService.roundToMarketTick(bidResult.value, tickSize, 'floor');
        const roundedAskResult = PriceService.roundToMarketTick(askResult.value, tickSize, 'ceil');
        expect(roundedBidResult.ok).toBe(true);
        expect(roundedAskResult.ok).toBe(true);

        if (roundedBidResult.ok && roundedAskResult.ok) {
          // Шаг 4: Валидируем alignment
          expect(PriceService.ensureAlignedToMarketTick(roundedBidResult.value, tickSize).ok).toBe(true);
          expect(PriceService.ensureAlignedToMarketTick(roundedAskResult.value, tickSize).ok).toBe(true);

          // Шаг 5: Вычисляем mid-price
          const midResult = PriceService.average(roundedBidResult.value, roundedAskResult.value);
          expect(midResult.ok).toBe(true);
        }
      }
    });

    it('вычисление комплемента и проверка суммы', () => {
      const price = Price.of(0.3);
      const complementResult = PriceService.complement(price);
      expect(complementResult.ok).toBe(true);

      if (complementResult.ok) {
        // Сумма price + complement ≈ 1.0
        const sum = price.value().plus(complementResult.value.value());
        expect(sum.toNumber()).toBeCloseTo(1.0, 10);
      }
    });
  });

  describe('Decimal configuration', () => {
    it('Decimal precision достаточна для Price операций', () => {
      // Проверяем что Decimal может точно представить MIN и MAX
      const minDecimal = new Decimal(0.0001);
      const maxDecimal = new Decimal(0.9999);

      expect(minDecimal.toNumber()).toBe(0.0001);
      expect(maxDecimal.toNumber()).toBe(0.9999);
    });

    it('Decimal arithmetic точна для Price диапазона', () => {
      const a = new Decimal(0.1);
      const b = new Decimal(0.2);
      const sum = a.plus(b);

      expect(sum.toString()).toBe('0.3');
      expect(sum.toNumber()).toBe(0.3);
    });

    it('div().isInteger() работает корректно для alignment проверок', () => {
      const aligned = new Decimal(0.5);
      const tickSize = new Decimal(0.1);
      expect(aligned.div(tickSize).isInteger()).toBe(true);

      const notAligned = new Decimal(0.55);
      expect(notAligned.div(tickSize).isInteger()).toBe(false);
    });
  });

  describe('multiply/divide семантика', () => {
    it('multiply с InvalidPriceError для невалидного factor', () => {
      const price = Price.of(0.5);
      const result = PriceService.multiply(price, 'invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('multiply');
        expect(result.error.context?.raw).toBeDefined(); // toDecimal добавляет raw
        expect(result.error.context?.factor).toBe('invalid'); // контракт требует factor
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('divide с DivisionByZeroError для нулевого divisor', () => {
      const price = Price.of(0.5);
      const result = PriceService.divide(price, 0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.divisor).toBe('0');
      }
    });

    it('divide с InvalidDivisorError для невалидного divisor', () => {
      const price = Price.of(0.5);
      const result = PriceService.divide(price, 'invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('divide');
        expect(result.error.context?.raw).toBeDefined(); // toDecimal добавляет raw
        expect(result.error.context?.divisor).toBe('invalid'); // контракт требует divisor
        expect(result.error.context?.price).toBeDefined();
      }
    });
  });

  describe('Adapters unknown валидация', () => {
    it('fromJSON валидирует структуру перед делегированием', () => {
      const invalidStructures = [
        null,
        42,
        'string',
        [],
        {},
        { value: {} },
        { value: [] },
        { wrongField: 0.5 }
      ];

      for (const invalid of invalidStructures) {
        const result = PriceSerializer.fromJSON(invalid);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
        }
      }
    });

    it('fromJSON делегирует бизнес-валидацию PriceService', () => {
      const outOfRange = [
        { value: 1.5 },
        { value: -0.5 },
        { value: 0.00001 }
      ];

      for (const invalid of outOfRange) {
        const result = PriceSerializer.fromJSON(invalid);
        expect(result.ok).toBe(false);
      }
    });
  });
});

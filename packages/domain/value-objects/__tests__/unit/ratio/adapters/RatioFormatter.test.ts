import { describe, it, expect } from '@jest/globals';
import { isErr } from '@polymarket/result';
import { RatioService } from '../../../../src/ratio/facade/RatioService';
import { RatioFormatter } from '../../../../src/ratio/adapters/RatioFormatter';
import { RatioErrorReason } from '../../../../src/ratio/errors/RatioErrorReason';

describe('RatioFormatter', () => {
  describe('toDecimal()', () => {
    it('форматирует с 4 знаками по умолчанию', () => {
      const ratioResult = RatioService.fromPercent(2);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toDecimal(ratioResult.value);
        expect(formatted.ok).toBe(true);
        if (formatted.ok) {
          expect(formatted.value).toBe('0.0200');
        }
      }
    });

    it('форматирует с заданным количеством знаков', () => {
      const ratioResult = RatioService.fromPercent(2.5);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toDecimal(ratioResult.value, 2);
        expect(formatted.ok).toBe(true);
        if (formatted.ok) {
          expect(formatted.value).toBe('0.03');
        }
      }
    });

    it('форматирует с 0 знаков', () => {
      const ratioResult = RatioService.fromDecimal(0.4);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toDecimal(ratioResult.value, 0);
        expect(formatted.ok).toBe(true);
        if (formatted.ok) {
          expect(formatted.value).toBe('0');
        }
      }
    });

    it('отклоняет отрицательное decimals', () => {
      const ratioResult = RatioService.fromPercent(2);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toDecimal(ratioResult.value, -1);
        expect(isErr(formatted)).toBe(true);
        if (isErr(formatted)) {
          expect(formatted.error.context?.reason).toBe(RatioErrorReason.INVALID_DECIMALS);
        }
      }
    });

    it('отклоняет дробное decimals', () => {
      const ratioResult = RatioService.fromPercent(2);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toDecimal(ratioResult.value, 2.5);
        expect(isErr(formatted)).toBe(true);
        if (isErr(formatted)) {
          expect(formatted.error.context?.reason).toBe(RatioErrorReason.INVALID_DECIMALS);
        }
      }
    });
  });

  describe('toPercent()', () => {
    it('форматирует как процент с 2 знаками по умолчанию', () => {
      const ratioResult = RatioService.fromDecimal(0.025);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toPercent(ratioResult.value);
        expect(formatted.ok).toBe(true);
        if (formatted.ok) {
          expect(formatted.value).toBe('2.50%');
        }
      }
    });

    it('форматирует с заданным количеством знаков', () => {
      const ratioResult = RatioService.fromDecimal(0.025);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toPercent(ratioResult.value, 1);
        expect(formatted.ok).toBe(true);
        if (formatted.ok) {
          expect(formatted.value).toBe('2.5%');
        }
      }
    });

    it('форматирует отрицательный процент', () => {
      const ratioResult = RatioService.fromDecimal(-0.1);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toPercent(ratioResult.value, 2);
        expect(formatted.ok).toBe(true);
        if (formatted.ok) {
          expect(formatted.value).toBe('-10.00%');
        }
      }
    });

    it('форматирует 100%', () => {
      const ratioResult = RatioService.fromDecimal(1);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toPercent(ratioResult.value, 0);
        expect(formatted.ok).toBe(true);
        if (formatted.ok) {
          expect(formatted.value).toBe('100%');
        }
      }
    });

    it('отклоняет отрицательное decimals', () => {
      const ratioResult = RatioService.fromPercent(2);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toPercent(ratioResult.value, -1);
        expect(isErr(formatted)).toBe(true);
        if (isErr(formatted)) {
          expect(formatted.error.context?.reason).toBe(RatioErrorReason.INVALID_DECIMALS);
        }
      }
    });
  });

  describe('toBps()', () => {
    it('форматирует как bps с 0 знаков по умолчанию', () => {
      const ratioResult = RatioService.fromDecimal(0.025);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toBps(ratioResult.value);
        expect(formatted.ok).toBe(true);
        if (formatted.ok) {
          expect(formatted.value).toBe('250 bps');
        }
      }
    });

    it('форматирует с заданным количеством знаков', () => {
      const ratioResult = RatioService.fromDecimal(0.0255);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toBps(ratioResult.value, 1);
        expect(formatted.ok).toBe(true);
        if (formatted.ok) {
          expect(formatted.value).toBe('255.0 bps');
        }
      }
    });

    it('форматирует отрицательные bps', () => {
      const ratioResult = RatioService.fromDecimal(-0.02);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toBps(ratioResult.value, 0);
        expect(formatted.ok).toBe(true);
        if (formatted.ok) {
          expect(formatted.value).toBe('-200 bps');
        }
      }
    });

    it('форматирует 100 bps (1%)', () => {
      const ratioResult = RatioService.fromDecimal(0.01);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toBps(ratioResult.value, 0);
        expect(formatted.ok).toBe(true);
        if (formatted.ok) {
          expect(formatted.value).toBe('100 bps');
        }
      }
    });

    it('отклоняет отрицательное decimals', () => {
      const ratioResult = RatioService.fromPercent(2);
      if (ratioResult.ok) {
        const formatted = RatioFormatter.toBps(ratioResult.value, -1);
        expect(isErr(formatted)).toBe(true);
        if (isErr(formatted)) {
          expect(formatted.error.context?.reason).toBe(RatioErrorReason.INVALID_DECIMALS);
        }
      }
    });
  });

  describe('parse()', () => {
    describe('decimal формат', () => {
      it('парсит "0.02"', () => {
        const result = RatioFormatter.parse('0.02');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('0.02');
        }
      });

      it('парсит "0.5"', () => {
        const result = RatioFormatter.parse('0.5');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('0.5');
        }
      });

      it('парсит "-0.1"', () => {
        const result = RatioFormatter.parse('-0.1');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('-0.1');
        }
      });
    });

    describe('percent формат', () => {
      it('парсит "2%"', () => {
        const result = RatioFormatter.parse('2%');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('0.02');
        }
      });

      it('парсит "100%"', () => {
        const result = RatioFormatter.parse('100%');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('1');
        }
      });

      it('парсит "-10%"', () => {
        const result = RatioFormatter.parse('-10%');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('-0.1');
        }
      });

      it('парсит "2.5%"', () => {
        const result = RatioFormatter.parse('2.5%');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('0.025');
        }
      });

      it('игнорирует пробелы', () => {
        const result = RatioFormatter.parse('  2%  ');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('0.02');
        }
      });
    });

    describe('bps формат', () => {
      it('парсит "200 bps"', () => {
        const result = RatioFormatter.parse('200 bps');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('0.02');
        }
      });

      it('парсит "100 bps"', () => {
        const result = RatioFormatter.parse('100 bps');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('0.01');
        }
      });

      it('парсит "10000 bps"', () => {
        const result = RatioFormatter.parse('10000 bps');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('1');
        }
      });

      it('парсит "-200 bps"', () => {
        const result = RatioFormatter.parse('-200 bps');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('-0.02');
        }
      });

      it('игнорирует пробелы', () => {
        const result = RatioFormatter.parse('  200 bps  ');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('0.02');
        }
      });
    });

    describe('high-precision формат', () => {
      it('сохраняет точность для decimal с множеством знаков', () => {
        // Regression test для Problem 1: precision loss при Number() конверсии
        const highPrecisionStr = '0.123456789123456789';
        const result = RatioFormatter.parse(highPrecisionStr);
        expect(result.ok).toBe(true);
        if (result.ok) {
          // Decimal.js должен сохранить полную точность
          expect(result.value.toDecimal().toString()).toBe(highPrecisionStr);
        }
      });

      it('сохраняет точность для percent с множеством знаков', () => {
        const highPrecisionStr = '12.3456789123456789%';
        const result = RatioFormatter.parse(highPrecisionStr);
        expect(result.ok).toBe(true);
        if (result.ok) {
          // 12.3456789123456789% => 0.123456789123456789
          expect(result.value.toDecimal().toString()).toBe('0.123456789123456789');
        }
      });

      it('сохраняет точность для bps с множеством знаков', () => {
        const highPrecisionStr = '1234.56789123456789 bps';
        const result = RatioFormatter.parse(highPrecisionStr);
        expect(result.ok).toBe(true);
        if (result.ok) {
          // 1234.56789123456789 bps => 0.123456789123456789
          expect(result.value.toDecimal().toString()).toBe('0.123456789123456789');
        }
      });

      it('сохраняет точность для отрицательного decimal', () => {
        const highPrecisionStr = '-0.987654321987654321';
        const result = RatioFormatter.parse(highPrecisionStr);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe(highPrecisionStr);
        }
      });

      it('сохраняет точность для очень малого decimal', () => {
        const highPrecisionStr = '0.000000000123456789';
        const result = RatioFormatter.parse(highPrecisionStr);
        expect(result.ok).toBe(true);
        if (result.ok) {
          // Decimal.js может использовать экспоненциальную нотацию для очень малых чисел
          // Проверяем что значение сохранено точно через toFixed
          expect(result.value.toDecimal().toFixed(18)).toBe(highPrecisionStr);
        }
      });
    });

    describe('ошибки парсинга', () => {
      it('отклоняет некорректный формат', () => {
        const result = RatioFormatter.parse('invalid');
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_FORMAT);
        }
      });

      it('отклоняет пустую строку', () => {
        const result = RatioFormatter.parse('');
        expect(isErr(result)).toBe(true);
      });

      it('отклоняет некорректный процент', () => {
        const result = RatioFormatter.parse('abc%');
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_FORMAT);
        }
      });

      it('отклоняет некорректные bps', () => {
        const result = RatioFormatter.parse('abc bps');
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_FORMAT);
        }
      });

      // Regression tests для parseFloat trailing garbage bug
      it('отклоняет процент с trailing garbage', () => {
        const result = RatioFormatter.parse('2abc%');
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_FORMAT);
        }
      });

      it('отклоняет bps с trailing garbage', () => {
        const result = RatioFormatter.parse('1.2oops bps');
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_FORMAT);
        }
      });

      it('отклоняет decimal с trailing garbage', () => {
        const result = RatioFormatter.parse('0.02xyz');
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_FORMAT);
        }
      });
    });
  });

  describe('round-trip formatting', () => {
    it('decimal -> format -> parse -> equals', () => {
      const original = RatioService.fromDecimal(0.025);
      if (original.ok) {
        const formatted = RatioFormatter.toDecimal(original.value, 6);
        if (formatted.ok) {
          const parsed = RatioFormatter.parse(formatted.value);
          if (parsed.ok) {
            expect(original.value.equals(parsed.value)).toBe(true);
          }
        }
      }
    });

    it('percent -> format -> parse -> equals', () => {
      const original = RatioService.fromPercent(2.5);
      if (original.ok) {
        const formatted = RatioFormatter.toPercent(original.value, 1);
        if (formatted.ok) {
          const parsed = RatioFormatter.parse(formatted.value);
          if (parsed.ok) {
            expect(original.value.equals(parsed.value)).toBe(true);
          }
        }
      }
    });

    it('bps -> format -> parse -> equals', () => {
      const original = RatioService.fromBps(250);
      if (original.ok) {
        const formatted = RatioFormatter.toBps(original.value, 0);
        if (formatted.ok) {
          const parsed = RatioFormatter.parse(formatted.value);
          if (parsed.ok) {
            expect(original.value.equals(parsed.value)).toBe(true);
          }
        }
      }
    });
  });
});

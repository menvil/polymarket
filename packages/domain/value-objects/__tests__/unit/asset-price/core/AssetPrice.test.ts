/**
 * Инварианты Core-слоя AssetPrice.
 *
 * @remarks
 * Ключевой инвариант, ради которого VO существует: положительное значение
 * БЕЗ верхней границы. Именно этим он отличается от `OutcomePrice` рынка
 * предсказаний, ограниченного `[0.0001, 0.9999]`.
 */
import { describe, expect, it } from '@jest/globals';
import Decimal from 'decimal.js';
import {
  AssetPrice,
  AssetPriceErrorReason,
  AssetPriceInvariantViolation,
} from '../../../../src/index.js';

describe('AssetPrice.of', () => {
  it('принимает цену актива любой величины', () => {
    for (const raw of ['79341.36626633028', '3021.5', '0.00000001', '1', '1e30']) {
      expect(() => AssetPrice.of(new Decimal(raw))).not.toThrow();
    }
  });

  it('сохраняет точность десятичной строки', () => {
    const price = AssetPrice.of(new Decimal('79341.36626633028'));
    expect(price.value().toString()).toBe('79341.36626633028');
    expect(price.toString()).toBe('79341.36626633028');
  });

  it('отвергает ноль и отрицательные значения', () => {
    for (const raw of ['0', '-0.0001', '-79341.36']) {
      expect(() => AssetPrice.of(new Decimal(raw))).toThrow(AssetPriceInvariantViolation);
    }
  });

  it('отвергает NaN с типизированной причиной', () => {
    try {
      AssetPrice.of(new Decimal(NaN));
      throw new Error('expected invariant violation');
    } catch (error) {
      expect(error).toBeInstanceOf(AssetPriceInvariantViolation);
      expect((error as AssetPriceInvariantViolation).reason).toBe(
        AssetPriceErrorReason.NAN,
      );
    }
  });

  it('отвергает бесконечность с типизированной причиной', () => {
    try {
      AssetPrice.of(new Decimal(Infinity));
      throw new Error('expected invariant violation');
    } catch (error) {
      expect((error as AssetPriceInvariantViolation).reason).toBe(
        AssetPriceErrorReason.NON_FINITE,
      );
    }
  });

  it('неположительное значение сообщает причину NOT_POSITIVE', () => {
    try {
      AssetPrice.of(new Decimal('0'));
      throw new Error('expected invariant violation');
    } catch (error) {
      expect((error as AssetPriceInvariantViolation).reason).toBe(
        AssetPriceErrorReason.NOT_POSITIVE,
      );
    }
  });
});

describe('иммутабельность и сравнение', () => {
  it('экземпляр заморожен', () => {
    const price = AssetPrice.of(new Decimal('100'));
    expect(Object.isFrozen(price)).toBe(true);
  });

  it('equals сравнивает по значению, а не по записи числа', () => {
    const a = AssetPrice.of(new Decimal('1.10'));
    const b = AssetPrice.of(new Decimal('1.1'));
    const c = AssetPrice.of(new Decimal('1.2'));

    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});

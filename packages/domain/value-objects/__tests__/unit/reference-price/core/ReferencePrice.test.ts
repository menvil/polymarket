/**
 * Инварианты Core-слоя ReferencePrice.
 *
 * @remarks
 * Ключевой инвариант, ради которого VO существует: положительное значение
 * БЕЗ верхней границы. Именно этим он отличается от `Price` рынка
 * предсказаний, ограниченного `[0.0001, 0.9999]`.
 */
import { describe, expect, it } from '@jest/globals';
import Decimal from 'decimal.js';
import {
  ReferencePrice,
  ReferencePriceErrorReason,
  ReferencePriceInvariantViolation,
} from '../../../../src/index.js';

describe('ReferencePrice.of', () => {
  it('принимает цену актива любой величины', () => {
    for (const raw of ['79341.36626633028', '3021.5', '0.00000001', '1', '1e30']) {
      expect(() => ReferencePrice.of(new Decimal(raw))).not.toThrow();
    }
  });

  it('сохраняет точность десятичной строки', () => {
    const price = ReferencePrice.of(new Decimal('79341.36626633028'));
    expect(price.value().toString()).toBe('79341.36626633028');
    expect(price.toString()).toBe('79341.36626633028');
  });

  it('отвергает ноль и отрицательные значения', () => {
    for (const raw of ['0', '-0.0001', '-79341.36']) {
      expect(() => ReferencePrice.of(new Decimal(raw))).toThrow(ReferencePriceInvariantViolation);
    }
  });

  it('отвергает NaN с типизированной причиной', () => {
    try {
      ReferencePrice.of(new Decimal(NaN));
      throw new Error('expected invariant violation');
    } catch (error) {
      expect(error).toBeInstanceOf(ReferencePriceInvariantViolation);
      expect((error as ReferencePriceInvariantViolation).reason).toBe(
        ReferencePriceErrorReason.NAN,
      );
    }
  });

  it('отвергает бесконечность с типизированной причиной', () => {
    try {
      ReferencePrice.of(new Decimal(Infinity));
      throw new Error('expected invariant violation');
    } catch (error) {
      expect((error as ReferencePriceInvariantViolation).reason).toBe(
        ReferencePriceErrorReason.NON_FINITE,
      );
    }
  });

  it('неположительное значение сообщает причину NOT_POSITIVE', () => {
    try {
      ReferencePrice.of(new Decimal('0'));
      throw new Error('expected invariant violation');
    } catch (error) {
      expect((error as ReferencePriceInvariantViolation).reason).toBe(
        ReferencePriceErrorReason.NOT_POSITIVE,
      );
    }
  });
});

describe('иммутабельность и сравнение', () => {
  it('экземпляр заморожен', () => {
    const price = ReferencePrice.of(new Decimal('100'));
    expect(Object.isFrozen(price)).toBe(true);
  });

  it('equals сравнивает по значению, а не по записи числа', () => {
    const a = ReferencePrice.of(new Decimal('1.10'));
    const b = ReferencePrice.of(new Decimal('1.1'));
    const c = ReferencePrice.of(new Decimal('1.2'));

    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});

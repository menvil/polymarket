/**
 * Compile-time проверка контракта {@link DecimalPrice}.
 *
 * @remarks
 * Смысл контракта в том, что ОБА ценовых домена ему удовлетворяют
 * структурно — без `implements` и без правок в самих VO. Если кто-то
 * сузит `value()` или уберёт его, сборка упадёт здесь, а не в структурах,
 * которые на контракт опираются.
 */
import { describe, expect, it } from '@jest/globals';
import Decimal from 'decimal.js';
import {
  OutcomePrice,
  AssetPrice,
  Spread,
  type DecimalPrice,
} from '../../../../src/index.js';

describe('оба ценовых домена удовлетворяют контракту', () => {
  it('OutcomePrice присваивается DecimalPrice структурно', () => {
    const price: DecimalPrice = OutcomePrice.of(new Decimal('0.52'));
    expect(price.value().toString()).toBe('0.52');
  });

  it('AssetPrice присваивается DecimalPrice структурно', () => {
    const price: DecimalPrice = AssetPrice.of(new Decimal('78468.5'));
    expect(price.value().toString()).toBe('78468.5');
  });

  it('обобщённый код работает с любым доменом без знания о нём', () => {
    // Ровно то, ради чего контракт существует: структура выбирает лучшую
    // цену, не зная, вероятность это или цена актива
    const bestOf = <T extends DecimalPrice>(prices: readonly T[]): T | undefined =>
      prices.reduce<T | undefined>(
        (best, candidate) =>
          best === undefined || candidate.value().greaterThan(best.value()) ? candidate : best,
        undefined,
      );

    const outcome = bestOf([OutcomePrice.of(new Decimal('0.48')), OutcomePrice.of(new Decimal('0.52'))]);
    const asset = bestOf([
      AssetPrice.of(new Decimal('78468.5')),
      AssetPrice.of(new Decimal('78470.1')),
    ]);

    expect(outcome?.value().toString()).toBe('0.52');
    expect(asset?.value().toString()).toBe('78470.1');
  });

  it('контракт НЕ даёт создавать цену — только читать', () => {
    // У DecimalPrice нет ни фабрики, ни арифметики: создать новое значение
    // можно лишь зная домен, поэтому фабрика приходит от вызывающего
    type ContractKeys = keyof DecimalPrice;
    const only: ContractKeys = 'value';
    expect(only).toBe('value');
  });
});

describe('Spread работает с обоими доменами', () => {
  it('Spread по умолчанию остаётся prediction-спредом', () => {
    const spread = Spread.of(OutcomePrice.of(new Decimal('0.48')), OutcomePrice.of(new Decimal('0.52')));
    // Тип сохранён: default-параметр не меняет существующие сигнатуры
    const bid: OutcomePrice = spread.bid();
    expect(bid.value().toString()).toBe('0.48');
    expect(spread.width().toString()).toBe('0.04');
  });

  it('Spread строится и по ценам внешнего актива', () => {
    const spread = Spread.of(
      AssetPrice.of(new Decimal('78468.5')),
      AssetPrice.of(new Decimal('78470.1')),
    );
    const bid: AssetPrice = spread.bid();
    expect(bid.value().toString()).toBe('78468.5');
    // Та же арифметика, другой домен — 1.6 USDT ширины вместо 0.04 вероятности
    expect(spread.width().toString()).toBe('1.6');
  });

  it('инвариант bid <= ask действует в любом домене', () => {
    expect(() =>
      Spread.of(AssetPrice.of(new Decimal('78470.1')), AssetPrice.of(new Decimal('78468.5'))),
    ).toThrow();
  });
});

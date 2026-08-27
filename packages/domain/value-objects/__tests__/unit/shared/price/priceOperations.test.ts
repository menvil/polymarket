/**
 * Паритет операций между ценовыми доменами.
 *
 * @remarks
 * Общая реализация существует ради одного: одна и та же операция работает в
 * обоих доменах и в каждом проверяется ЕГО инвариантом. Тест фиксирует и то,
 * и другое — включая случаи, где домены обязаны вести себя ПО-РАЗНОМУ.
 */
import { describe, expect, it } from '@jest/globals';
import Decimal from 'decimal.js';
import {
  AssetPrice,
  AssetPriceService,
  OutcomePrice,
  OutcomePriceService,
} from '../../../../src/index.js';

describe('арифметика работает в обоих доменах', () => {
  it('multiply', () => {
    const outcome = OutcomePriceService.multiply(OutcomePrice.of(new Decimal('0.25')), 2);
    const asset = AssetPriceService.multiply(AssetPrice.of(new Decimal('78468.5')), 2);

    expect(outcome.ok).toBe(true);
    expect(asset.ok).toBe(true);
    if (!outcome.ok || !asset.ok) return;
    expect(outcome.value.value().toString()).toBe('0.5');
    expect(asset.value.value().toString()).toBe('156937');
  });

  it('divide', () => {
    const outcome = OutcomePriceService.divide(OutcomePrice.of(new Decimal('0.5')), 2);
    const asset = AssetPriceService.divide(AssetPrice.of(new Decimal('78468.5')), 2);

    expect(outcome.ok && outcome.value.value().toString()).toBe('0.25');
    expect(asset.ok && asset.value.value().toString()).toBe('39234.25');
  });

  it('average', () => {
    const outcome = OutcomePriceService.average(
      OutcomePrice.of(new Decimal('0.4')),
      OutcomePrice.of(new Decimal('0.6')),
    );
    const asset = AssetPriceService.average(
      AssetPrice.of(new Decimal('78468')),
      AssetPrice.of(new Decimal('78470')),
    );

    expect(outcome.ok && outcome.value.value().toString()).toBe('0.5');
    expect(asset.ok && asset.value.value().toString()).toBe('78469');
  });
});

describe('каждый домен проверяет результат СВОИМ инвариантом', () => {
  it('выход за [0.0001, 0.9999] — ошибка только у рынка предсказаний', () => {
    // Одна и та же операция: удвоение
    const outcome = OutcomePriceService.multiply(OutcomePrice.of(new Decimal('0.6')), 2);
    const asset = AssetPriceService.multiply(AssetPrice.of(new Decimal('78468.5')), 2);

    expect(outcome.ok).toBe(false); // 1.2 вне домена доли исхода
    expect(asset.ok).toBe(true); // 156937 — обычная цена актива
  });

  it('неположительный результат — ошибка в ОБОИХ доменах', () => {
    expect(OutcomePriceService.multiply(OutcomePrice.of(new Decimal('0.5')), 0).ok).toBe(false);
    expect(AssetPriceService.multiply(AssetPrice.of(new Decimal('78468.5')), 0).ok).toBe(false);
  });

  it('нулевой делитель отвергается в обоих доменах до самого деления', () => {
    expect(OutcomePriceService.divide(OutcomePrice.of(new Decimal('0.5')), 0).ok).toBe(false);
    expect(AssetPriceService.divide(AssetPrice.of(new Decimal('78468.5')), 0).ok).toBe(false);
  });
});

describe('тик: базовый шаг у каждого домена свой', () => {
  it('рынок предсказаний использует свой базовый тик неявно', () => {
    const result = OutcomePriceService.roundToMarketTick(
      OutcomePrice.of(new Decimal('0.5234')),
      '0.01',
    );
    expect(result.ok && result.value.value().toString()).toBe('0.52');
  });

  it('биржа передаёт базовый тик инструмента явно', () => {
    // У биржи он свой на каждый инструмент и приходит из market info —
    // именно поэтому параметр, а не константа
    const result = AssetPriceService.roundToTick(
      AssetPrice.of(new Decimal('78468.537')),
      '0.01',
      '0.00000001',
    );
    expect(result.ok && result.value.value().toString()).toBe('78468.54');
  });

  it('режимы округления работают одинаково в обоих доменах', () => {
    const outcomeFloor = OutcomePriceService.roundToMarketTick(
      OutcomePrice.of(new Decimal('0.5289')),
      '0.01',
      'floor',
    );
    const assetFloor = AssetPriceService.roundToTick(
      AssetPrice.of(new Decimal('78468.589')),
      '0.01',
      '0.00000001',
      'floor',
    );

    expect(outcomeFloor.ok && outcomeFloor.value.value().toString()).toBe('0.52');
    expect(assetFloor.ok && assetFloor.value.value().toString()).toBe('78468.58');
  });

  it('цена вне сетки ловится в обоих доменах', () => {
    expect(
      OutcomePriceService.ensureAlignedToMarketTick(OutcomePrice.of(new Decimal('0.1235')), '0.01')
        .ok,
    ).toBe(false);
    expect(
      AssetPriceService.ensureAlignedToTick(
        AssetPrice.of(new Decimal('78468.537')),
        '0.01',
        '0.00000001',
      ).ok,
    ).toBe(false);
  });
});

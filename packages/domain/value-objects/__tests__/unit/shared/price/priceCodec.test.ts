/**
 * Паритет адаптеров между ценовыми доменами.
 *
 * @remarks
 * Форматирование и JSON round-trip реализованы один раз; тест фиксирует, что
 * оба домена ведут себя одинаково там, где логика общая, и по-разному там,
 * где различаются инварианты.
 */
import { describe, expect, it } from '@jest/globals';
import Decimal from 'decimal.js';
import {
  AssetPrice,
  AssetPriceFormatter,
  AssetPriceSerializer,
  OutcomePrice,
  OutcomePriceFormatter,
  OutcomePriceSerializer,
} from '../../../../src/index.js';

describe('форматирование работает в обоих доменах', () => {
  it('toFixed', () => {
    const outcome = OutcomePriceFormatter.toFixed(OutcomePrice.of(new Decimal('0.52')), 4);
    const asset = AssetPriceFormatter.toFixed(AssetPrice.of(new Decimal('78468.5')), 2);

    expect(outcome.ok && outcome.value).toBe('0.5200');
    expect(asset.ok && asset.value).toBe('78468.50');
  });

  it('некорректный decimals отвергается в обоих доменах', () => {
    expect(OutcomePriceFormatter.toFixed(OutcomePrice.of(new Decimal('0.5')), -1).ok).toBe(false);
    expect(AssetPriceFormatter.toFixed(AssetPrice.of(new Decimal('78468.5')), 1.5).ok).toBe(false);
  });

  it('процентное представление есть ТОЛЬКО у рынка предсказаний', () => {
    // Доля исхода в процентах читается, цена актива — нет («7846850%»)
    const percent = OutcomePriceFormatter.toPercentage(OutcomePrice.of(new Decimal('0.52')), 2);
    expect(percent.ok && percent.value).toBe('52.00%');
    expect('toPercentage' in AssetPriceFormatter).toBe(false);
  });
});

describe('JSON round-trip работает в обоих доменах', () => {
  it('значение переживает round-trip без потери точности', () => {
    const raw = '78376.356031481042173952';
    const json = AssetPriceSerializer.toJSON(AssetPrice.of(new Decimal(raw)));
    expect(json.value).toBe(raw);

    const restored = AssetPriceSerializer.fromJSON(json);
    expect(restored.ok && restored.value.value().toString()).toBe(raw);
    // Через number такой round-trip не прошёл бы
    expect(String(Number(raw))).not.toBe(raw);
  });

  it('prediction round-trip тоже цел', () => {
    const json = OutcomePriceSerializer.toJSON(OutcomePrice.of(new Decimal('0.123456789')));
    const restored = OutcomePriceSerializer.fromJSON(json);
    expect(restored.ok && restored.value.value().toString()).toBe('0.123456789');
  });

  it('мусорный ввод отвергается одинаково', () => {
    for (const bad of [null, 42, 'string', [1, 2], {}, { value: {} }]) {
      expect(OutcomePriceSerializer.fromJSON(bad).ok).toBe(false);
      expect(AssetPriceSerializer.fromJSON(bad).ok).toBe(false);
    }
  });
});

describe('десериализация проверяет инвариант СВОЕГО домена', () => {
  it('78468.5 восстанавливается только как цена актива', () => {
    expect(AssetPriceSerializer.fromJSON({ value: '78468.5' }).ok).toBe(true);
    // Для доли исхода это значение вне домена — round-trip невозможен
    expect(OutcomePriceSerializer.fromJSON({ value: '78468.5' }).ok).toBe(false);
  });

  it('ноль отвергается обоими, но по своим причинам', () => {
    expect(AssetPriceSerializer.fromJSON({ value: '0' }).ok).toBe(false);
    expect(OutcomePriceSerializer.fromJSON({ value: '0' }).ok).toBe(false);
  });
});

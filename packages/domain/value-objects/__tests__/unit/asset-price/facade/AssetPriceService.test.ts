/**
 * Never-throw контракт фасада AssetPrice и сохранение точности.
 *
 * @remarks
 * Отдельно фиксируется главное различие доменов: значение, которое
 * `PriceService` обязан ОТВЕРГНУТЬ, `AssetPriceService` обязан принять.
 */
import { describe, expect, it } from '@jest/globals';
import Decimal from 'decimal.js';
import {
  PriceService,
  AssetPriceErrorReason,
  AssetPriceService,
} from '../../../../src/index.js';

describe('AssetPriceService.create', () => {
  it('парсит десятичную строку без промежуточного number', () => {
    const result = AssetPriceService.create('79341.36626633028');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.value().toString()).toBe('79341.36626633028');
  });

  it('сохраняет точность, которую потерял бы JS number', () => {
    // 20 значащих цифр: round-trip через double исказил бы значение
    const raw = '78376.356031481042173952';
    const result = AssetPriceService.create(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.value().toString()).toBe(raw);
    expect(String(Number(raw))).not.toBe(raw);
  });

  it('принимает Decimal и number', () => {
    expect(AssetPriceService.create(new Decimal('42.5')).ok).toBe(true);
    expect(AssetPriceService.create(3021.5).ok).toBe(true);
  });

  it('возвращает Err, а не бросает, на неположительном значении', () => {
    const result = AssetPriceService.create('0');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context?.['reason']).toBe(AssetPriceErrorReason.NOT_POSITIVE);
  });

  it('возвращает Err на отрицательном значении', () => {
    expect(AssetPriceService.create('-1').ok).toBe(false);
  });

  it('возвращает Err на непарсящейся строке', () => {
    const result = AssetPriceService.create('not-a-number');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context?.['reason']).toBe(AssetPriceErrorReason.INVALID_FORMAT);
  });

  it('возвращает Err на NaN и Infinity с разными причинами', () => {
    const nan = AssetPriceService.create(NaN);
    const inf = AssetPriceService.create(Infinity);

    expect(nan.ok).toBe(false);
    expect(inf.ok).toBe(false);
    if (nan.ok || inf.ok) return;
    expect(nan.error.context?.['reason']).toBe(AssetPriceErrorReason.NAN);
    expect(inf.error.context?.['reason']).toBe(AssetPriceErrorReason.NON_FINITE);
  });

  it('никогда не бросает — даже на явно мусорном вводе', () => {
    for (const raw of ['', '  ', 'NaN', '1.2.3', '0x10']) {
      expect(() => AssetPriceService.create(raw)).not.toThrow();
    }
  });
});

describe('разделение доменов с Price', () => {
  it('цена актива отвергается Price и принимается AssetPrice', () => {
    expect(PriceService.create('79341.36').ok).toBe(false);
    expect(AssetPriceService.create('79341.36').ok).toBe(true);
  });

  it('вероятностная цена валидна в обоих доменах — они пересекаются, но не совпадают', () => {
    expect(PriceService.create('0.42').ok).toBe(true);
    expect(AssetPriceService.create('0.42').ok).toBe(true);
  });
});

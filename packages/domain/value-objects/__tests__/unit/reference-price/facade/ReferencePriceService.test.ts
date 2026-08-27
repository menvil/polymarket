/**
 * Never-throw контракт фасада ReferencePrice и сохранение точности.
 *
 * @remarks
 * Отдельно фиксируется главное различие доменов: значение, которое
 * `PriceService` обязан ОТВЕРГНУТЬ, `ReferencePriceService` обязан принять.
 */
import { describe, expect, it } from '@jest/globals';
import Decimal from 'decimal.js';
import {
  PriceService,
  ReferencePriceErrorReason,
  ReferencePriceService,
} from '../../../../src/index.js';

describe('ReferencePriceService.create', () => {
  it('парсит десятичную строку без промежуточного number', () => {
    const result = ReferencePriceService.create('79341.36626633028');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.value().toString()).toBe('79341.36626633028');
  });

  it('сохраняет точность, которую потерял бы JS number', () => {
    // 20 значащих цифр: round-trip через double исказил бы значение
    const raw = '78376.356031481042173952';
    const result = ReferencePriceService.create(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.value().toString()).toBe(raw);
    expect(String(Number(raw))).not.toBe(raw);
  });

  it('принимает Decimal и number', () => {
    expect(ReferencePriceService.create(new Decimal('42.5')).ok).toBe(true);
    expect(ReferencePriceService.create(3021.5).ok).toBe(true);
  });

  it('возвращает Err, а не бросает, на неположительном значении', () => {
    const result = ReferencePriceService.create('0');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context?.['reason']).toBe(ReferencePriceErrorReason.NOT_POSITIVE);
  });

  it('возвращает Err на отрицательном значении', () => {
    expect(ReferencePriceService.create('-1').ok).toBe(false);
  });

  it('возвращает Err на непарсящейся строке', () => {
    const result = ReferencePriceService.create('not-a-number');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context?.['reason']).toBe(ReferencePriceErrorReason.INVALID_FORMAT);
  });

  it('возвращает Err на NaN и Infinity с разными причинами', () => {
    const nan = ReferencePriceService.create(NaN);
    const inf = ReferencePriceService.create(Infinity);

    expect(nan.ok).toBe(false);
    expect(inf.ok).toBe(false);
    if (nan.ok || inf.ok) return;
    expect(nan.error.context?.['reason']).toBe(ReferencePriceErrorReason.NAN);
    expect(inf.error.context?.['reason']).toBe(ReferencePriceErrorReason.NON_FINITE);
  });

  it('никогда не бросает — даже на явно мусорном вводе', () => {
    for (const raw of ['', '  ', 'NaN', '1.2.3', '0x10']) {
      expect(() => ReferencePriceService.create(raw)).not.toThrow();
    }
  });
});

describe('разделение доменов с Price', () => {
  it('цена актива отвергается Price и принимается ReferencePrice', () => {
    expect(PriceService.create('79341.36').ok).toBe(false);
    expect(ReferencePriceService.create('79341.36').ok).toBe(true);
  });

  it('вероятностная цена валидна в обоих доменах — они пересекаются, но не совпадают', () => {
    expect(PriceService.create('0.42').ok).toBe(true);
    expect(ReferencePriceService.create('0.42').ok).toBe(true);
  });
});

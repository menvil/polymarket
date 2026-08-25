/**
 * Тесты vendor-boundary извлечения данных финализации (N-004 PART 18/19/20/21).
 *
 * @remarks
 * Fixtures повторяют live-характеризацию 2026-08-24 (SDK 0.6.0): metadata —
 * JSON numbers, outcome prices — DecimalStrings, `umaResolutionStatus` —
 * `'resolved'` после резолюции.
 */
import { describe, it, expect } from '@jest/globals';
import {
  compareDecimalStrings,
  deriveWinnerFromCryptoPrices,
  deriveWinningOutcome,
  extractCryptoFinalization,
  mapFinalOutcomes,
  meanOfDecimalStrings,
} from '../src/index.js';
import { TOKEN_ID_BTC_DOWN, TOKEN_ID_BTC_UP, createSdkMarket } from './helpers/gammaFixtures.js';

describe('extractCryptoFinalization (характеризовано live)', () => {
  it('vendor JSON numbers → точные десятичные строки без Number-конверсий', () => {
    const extracted = extractCryptoFinalization({
      finalPrice: 78325.4503724296,
      priceToBeat: 78027.33965248794,
    });

    expect(extracted).toEqual({
      priceToBeat: '78027.33965248794',
      finalPrice: '78325.4503724296',
    });
  });

  it('строковые значения проходят as-is (без парсинга)', () => {
    const extracted = extractCryptoFinalization({
      priceToBeat: '78027.339652487940', // хвостовой ноль сохраняется
    });

    expect(extracted).toEqual({ priceToBeat: '78027.339652487940' });
    expect(extracted.finalPrice).toBeUndefined();
  });

  it('отсутствующая/пустая metadata и непригодные значения → пустой результат', () => {
    expect(extractCryptoFinalization(null)).toEqual({});
    expect(extractCryptoFinalization(undefined)).toEqual({});
    expect(extractCryptoFinalization({})).toEqual({});
    expect(
      extractCryptoFinalization({ priceToBeat: Number.NaN, finalPrice: '   ' }),
    ).toEqual({});
    expect(extractCryptoFinalization({ priceToBeat: { nested: true } })).toEqual({});
  });
});

describe('mapFinalOutcomes: нейтральные исходы без vendor yes/no', () => {
  it('переносит labels/instrument ids/цены в vendor-порядке', () => {
    const market = createSdkMarket({}); // цены по умолчанию '0.5'/'0.5'

    const outcomes = mapFinalOutcomes(market);

    expect(outcomes).toEqual([
      { label: 'Up', instrumentId: TOKEN_ID_BTC_UP, price: '0.5' },
      { label: 'Down', instrumentId: TOKEN_ID_BTC_DOWN, price: '0.5' },
    ]);
  });

  it('исход без CLOB-токена опускается', () => {
    const market = createSdkMarket({ noTokenId: null });

    expect(mapFinalOutcomes(market)).toEqual([
      { label: 'Up', instrumentId: TOKEN_ID_BTC_UP, price: '0.5' },
    ]);
  });
});

describe('deriveWinningOutcome: только однозначный settlement (PART 21)', () => {
  const settled = [
    { label: 'Up', instrumentId: TOKEN_ID_BTC_UP as never, price: '1' },
    { label: 'Down', instrumentId: TOKEN_ID_BTC_DOWN as never, price: '0' },
  ];

  it('resolved + цены 1/0 → победитель определён', () => {
    const winner = deriveWinningOutcome(settled, 'resolved');
    expect(winner?.label).toBe('Up');
    expect(winner?.instrumentId).toBe(TOKEN_ID_BTC_UP);
  });

  it('без resolved-статуса победитель НЕ выводится (даже при 1/0)', () => {
    expect(deriveWinningOutcome(settled, null)).toBeUndefined();
    expect(deriveWinningOutcome(settled, 'proposed')).toBeUndefined();
  });

  it('до-резолюционные цены (0.995/0.005) — неоднозначно → undefined', () => {
    const live = [
      { label: 'Up', instrumentId: TOKEN_ID_BTC_UP as never, price: '0.995' },
      { label: 'Down', instrumentId: TOKEN_ID_BTC_DOWN as never, price: '0.005' },
    ];
    expect(deriveWinningOutcome(live, 'resolved')).toBeUndefined();
  });

  it('два «победителя», отсутствующая цена или пустой список → undefined', () => {
    const both = settled.map((outcome) => ({ ...outcome, price: '1' }));
    expect(deriveWinningOutcome(both, 'resolved')).toBeUndefined();
    const missing = [settled[0]!, { ...settled[1]!, price: undefined }];
    expect(deriveWinningOutcome(missing, 'resolved')).toBeUndefined();
    expect(deriveWinningOutcome([], 'resolved')).toBeUndefined();
  });

  it('Decimal-эквивалентные представления (1.0/0.00) принимаются', () => {
    const equivalent = [
      { label: 'Up', instrumentId: TOKEN_ID_BTC_UP as never, price: '1.0' },
      { label: 'Down', instrumentId: TOKEN_ID_BTC_DOWN as never, price: '0.00' },
    ];
    expect(deriveWinningOutcome(equivalent, 'resolved')?.label).toBe('Up');
  });
});

describe('deriveWinnerFromCryptoPrices: формула рынка на официальных ценах', () => {
  const outcomes = [
    { label: 'Up', instrumentId: TOKEN_ID_BTC_UP as never },
    { label: 'Down', instrumentId: TOKEN_ID_BTC_DOWN as never },
  ];

  it('live-значения BTC 2026-08-25 (79233.50… → 79237.63…) дают Up', () => {
    // Официально резолвлен в Up (проверено против Gamma после резолюции)
    const winner = deriveWinnerFromCryptoPrices(outcomes, {
      priceToBeat: '79233.50451521577',
      finalPrice: '79237.63456493833',
    });
    expect(winner?.label).toBe('Up');
    expect(winner?.instrumentId).toBe(TOKEN_ID_BTC_UP);
  });

  it('finalPrice < priceToBeat → Down', () => {
    const winner = deriveWinnerFromCryptoPrices(outcomes, {
      priceToBeat: '79233.50451521577',
      finalPrice: '79233.50451521576',
    });
    expect(winner?.label).toBe('Down');
  });

  it('равенство → Up (правило серии: greater than OR EQUAL)', () => {
    const winner = deriveWinnerFromCryptoPrices(outcomes, {
      priceToBeat: '2477.1301462980823',
      finalPrice: '2477.1301462980823',
    });
    expect(winner?.label).toBe('Up');
  });

  it('сравнение Decimal-ом, а не Number: subnormal-разница меняет исход', () => {
    // Обе строки дают ОДИН И ТОТ ЖЕ double → Number-сравнение сказало бы «равно» → Up
    const priceToBeat = '79237.634564938330000001';
    const finalPrice = '79237.63456493833';
    expect(Number(priceToBeat)).toBe(Number(finalPrice));
    expect(deriveWinnerFromCryptoPrices(outcomes, { priceToBeat, finalPrice })?.label).toBe('Down');
  });

  it('неполные цены → undefined (победитель не придумывается)', () => {
    expect(
      deriveWinnerFromCryptoPrices(outcomes, { priceToBeat: '79233.5' }),
    ).toBeUndefined();
    expect(deriveWinnerFromCryptoPrices(outcomes, { finalPrice: '79237.6' })).toBeUndefined();
    expect(deriveWinnerFromCryptoPrices(outcomes, {})).toBeUndefined();
  });

  it('не-Up/Down метки или иное число исходов → undefined (правило чужой серии)', () => {
    const yesNo = [
      { label: 'Yes', instrumentId: TOKEN_ID_BTC_UP as never },
      { label: 'No', instrumentId: TOKEN_ID_BTC_DOWN as never },
    ];
    const crypto = { priceToBeat: '100', finalPrice: '101' };
    expect(deriveWinnerFromCryptoPrices(yesNo, crypto)).toBeUndefined();
    expect(deriveWinnerFromCryptoPrices([outcomes[0]!], crypto)).toBeUndefined();
    expect(deriveWinnerFromCryptoPrices([], crypto)).toBeUndefined();
  });

  it('непарсящиеся значения → undefined', () => {
    expect(
      deriveWinnerFromCryptoPrices(outcomes, { priceToBeat: 'n/a', finalPrice: '101' }),
    ).toBeUndefined();
  });

  it('нефинитные vendor-строки → undefined (Infinity.gte дал бы ложный Up)', () => {
    for (const nonFinite of ['NaN', 'Infinity', '-Infinity']) {
      expect(
        deriveWinnerFromCryptoPrices(outcomes, { priceToBeat: '100', finalPrice: nonFinite }),
      ).toBeUndefined();
      expect(
        deriveWinnerFromCryptoPrices(outcomes, { priceToBeat: nonFinite, finalPrice: '100' }),
      ).toBeUndefined();
    }
  });
});

describe('Decimal-хелперы vendor-boundary', () => {
  it('compareDecimalStrings: -1 / 0 / 1 и undefined на мусоре', () => {
    expect(compareDecimalStrings('1', '2')).toBe(-1);
    expect(compareDecimalStrings('2.50', '2.5')).toBe(0);
    expect(compareDecimalStrings('2.5000001', '2.5')).toBe(1);
    expect(compareDecimalStrings('abc', '2.5')).toBeUndefined();
  });

  it('meanOfDecimalStrings: точное среднее без float-артефактов', () => {
    // 0.1 + 0.2 в double = 0.30000000000000004 → среднее 0.15000000000000002
    expect(meanOfDecimalStrings(['0.1', '0.2'])).toBe('0.15');
    expect(meanOfDecimalStrings(['79020.1', '79030.3', '79040.5'])).toBe('79030.3');
    expect(meanOfDecimalStrings([])).toBeUndefined();
    expect(meanOfDecimalStrings(['1', 'oops'])).toBeUndefined();
  });

  it('нефинитные значения отвергаются обоими хелперами', () => {
    for (const nonFinite of ['NaN', 'Infinity', '-Infinity']) {
      expect(compareDecimalStrings(nonFinite, '1')).toBeUndefined();
      expect(compareDecimalStrings('1', nonFinite)).toBeUndefined();
      // Одно отравленное наблюдение ряда не даёт «средним» строку 'NaN'
      expect(meanOfDecimalStrings([nonFinite])).toBeUndefined();
      expect(meanOfDecimalStrings(['79020.1', nonFinite, '79040.5'])).toBeUndefined();
    }
  });
});

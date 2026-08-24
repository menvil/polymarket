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
  deriveWinningOutcome,
  extractCryptoFinalization,
  mapFinalOutcomes,
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

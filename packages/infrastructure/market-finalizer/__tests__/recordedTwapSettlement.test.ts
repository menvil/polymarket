/**
 * Deterministic-деривация итога из записанного settlement-ряда (MR-B).
 *
 * @remarks
 * Фикстуры воспроизводят РЕАЛЬНЫЙ замер 2026-08-26 (btc-updown-5m
 * 13:45–13:50Z): официальные `priceToBeat`/`finalPrice` Gamma совпали с
 * наблюдениями TWAP-60 ровно на границах рынка. Тесты закрепляют именно
 * это правило и запрещают «ближайшее наблюдение» как замену точной границы.
 */
import { describe, expect, it } from '@jest/globals';
import type { PolymarketTwapRtdsFeed } from '@polymarket/polymarket-v2';
import { deriveWinnerFromRecordedTwap } from '../src/recordedTwapSettlement.js';

const FEED: PolymarketTwapRtdsFeed = {
  topic: 'prices.crypto.chainlink.twap',
  symbol: 'btc/usd',
  windowSeconds: 60,
};

const START_MS = Date.parse('2026-08-26T13:45:00.000Z');
const END_MS = Date.parse('2026-08-26T13:50:00.000Z');

/** Строка записанного датасета: payload-only SDK-событие settlement-потока. */
function twapLine(
  timestampMs: number,
  value: string,
  overrides: { symbol?: string; windowSeconds?: number; topic?: string } = {},
): string {
  return JSON.stringify({
    topic: overrides.topic ?? FEED.topic,
    type: 'update',
    timestamp: timestampMs + 1_895, // vendor publish-время (замеренная задержка)
    payload: {
      symbol: overrides.symbol ?? FEED.symbol,
      timestamp: timestampMs,
      value,
      windowSeconds: overrides.windowSeconds ?? FEED.windowSeconds,
    },
  });
}

/** Ряд реального замера: открытие, середина, граница закрытия и хвост. */
function realSeries(): string[] {
  return [
    twapLine(START_MS - 1_000, '78448.77726972446244864'),
    twapLine(START_MS, '78449.05813530705395712'),
    twapLine(START_MS + 1_000, '78450.033058151321829376'),
    twapLine(END_MS - 2_000, '78402.25986652135227392'),
    twapLine(END_MS - 1_000, '78401.533385091772841984'),
    twapLine(END_MS, '78400.701754893592952832'),
    // Секунда после границы ДУБЛИРУЕТ её значение — «ближайшее» было бы
    // неоднозначным выбором из двух равноудалённых наблюдений
    twapLine(END_MS + 1_000, '78400.701754893592952832'),
    twapLine(END_MS + 2_000, '78399.868852080044146688'),
  ];
}

describe('deriveWinnerFromRecordedTwap: правило рынка на точных границах', () => {
  it('воспроизводит официальный итог реального рынка (Down)', () => {
    const derived = deriveWinnerFromRecordedTwap(realSeries(), FEED, START_MS, END_MS);

    // Официальные числа Gamma того же рынка: 78449.05813530706 / 78400.7017548936
    expect(derived).toEqual({
      label: 'Down',
      priceToBeat: { timestampMs: START_MS, value: '78449.05813530705395712' },
      finalPrice: { timestampMs: END_MS, value: '78400.701754893592952832' },
      observations: 8,
    });
  });

  it('finalPrice > priceToBeat → Up', () => {
    const lines = [twapLine(START_MS, '100.0'), twapLine(END_MS, '100.5')];
    expect(deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS)?.label).toBe('Up');
  });

  it('tie (finalPrice == priceToBeat) → Up, как написано в правиле серии', () => {
    const lines = [twapLine(START_MS, '78449.05813530705395712'), twapLine(END_MS, '78449.05813530705395712')];
    expect(deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS)?.label).toBe('Up');
  });

  it('сравнение точное: разница в 18-м знаке НЕ теряется', () => {
    // Number() схлопнул бы эти значения в одно и дал бы ложный tie → Up
    const lines = [
      twapLine(START_MS, '78449.058135307053957120000001'),
      twapLine(END_MS, '78449.058135307053957120000000'),
    ];
    expect(deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS)?.label).toBe('Down');
  });
});

describe('границы обязаны быть покрыты рядом (PART 33/34/71)', () => {
  it('нет наблюдения РОВНО на закрытии → деривация недоступна', () => {
    const lines = [
      twapLine(START_MS, '100.0'),
      twapLine(END_MS - 1_000, '101.0'),
      twapLine(END_MS + 1_000, '101.5'), // соседи есть, точной границы нет
    ];
    expect(deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS)).toBeUndefined();
  });

  it('нет наблюдения РОВНО на открытии → деривация недоступна', () => {
    const lines = [twapLine(START_MS + 1_000, '100.0'), twapLine(END_MS, '101.0')];
    expect(deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS)).toBeUndefined();
  });

  it('ряд, целиком лежащий ДО окна рынка (stale), не даёт итога', () => {
    const lines = [
      twapLine(START_MS - 120_000, '100.0'),
      twapLine(START_MS - 60_000, '101.0'),
    ];
    expect(deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS)).toBeUndefined();
  });

  it('пустой ряд не даёт итога', () => {
    expect(deriveWinnerFromRecordedTwap([], FEED, START_MS, END_MS)).toBeUndefined();
  });

  it('нефинитные/невалидные границы не дают итога', () => {
    const lines = realSeries();
    expect(deriveWinnerFromRecordedTwap(lines, FEED, Number.NaN, END_MS)).toBeUndefined();
    expect(deriveWinnerFromRecordedTwap(lines, FEED, END_MS, START_MS)).toBeUndefined();
    expect(deriveWinnerFromRecordedTwap(lines, FEED, START_MS, START_MS)).toBeUndefined();
  });
});

describe('фид сверяется по содержимому строки, а не по фильтру чтения', () => {
  it('наблюдения ЧУЖОГО окна игнорируются', () => {
    // Дешёвый строковый префильтр читателя пропускает оба окна одного
    // символа — окончательное решение принимается здесь, по payload
    const lines = [
      twapLine(START_MS, '100.0', { windowSeconds: 30 }),
      twapLine(END_MS, '105.0', { windowSeconds: 30 }),
    ];
    expect(deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS)).toBeUndefined();
  });

  it('наблюдения чужого символа игнорируются', () => {
    const lines = [
      twapLine(START_MS, '100.0', { symbol: 'eth/usd' }),
      twapLine(END_MS, '105.0', { symbol: 'eth/usd' }),
    ];
    expect(deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS)).toBeUndefined();
  });

  it('spot-строки того же символа НЕ считаются settlement-наблюдениями', () => {
    const spot = JSON.stringify({
      topic: 'prices.crypto.chainlink',
      type: 'update',
      timestamp: END_MS,
      payload: { symbol: 'btc/usd', timestamp: END_MS, value: '99999.0' },
    });
    const lines = [twapLine(START_MS, '100.0'), spot];
    expect(deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS)).toBeUndefined();
  });

  it('чужие строки датасета и мусор не ломают разбор', () => {
    const lines = [
      'не json',
      JSON.stringify({ topic: 'market', type: 'book', payload: { market: '0xabc' } }),
      twapLine(START_MS, '100.0'),
      twapLine(END_MS, '101.0'),
    ];
    expect(deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS)?.label).toBe('Up');
  });

  it('нечисловой/пустой value отбрасывается как непригодное наблюдение', () => {
    const lines = [
      twapLine(START_MS, ''),
      twapLine(END_MS, '101.0'),
    ];
    expect(deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS)).toBeUndefined();
  });

  it('нефинитное значение на границе не даёт итога (Infinity.gte дал бы ложный Up)', () => {
    const lines = [twapLine(START_MS, 'Infinity'), twapLine(END_MS, '101.0')];
    expect(deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS)).toBeUndefined();
  });
});

describe('официальный priceToBeat имеет приоритет над записанным (PART 31)', () => {
  it('переданное официальное значение становится эталоном открытия', () => {
    const lines = realSeries();
    const derived = deriveWinnerFromRecordedTwap(
      lines,
      FEED,
      START_MS,
      END_MS,
      '78449.05813530706', // как отдаёт Gamma (double-округление)
    );

    expect(derived?.priceToBeat.value).toBe('78449.05813530706');
    expect(derived?.finalPrice.value).toBe('78400.701754893592952832');
    expect(derived?.label).toBe('Down');
  });

  it('официальное значение может ПЕРЕВЕРНУТЬ исход относительно записанного', () => {
    const lines = [twapLine(START_MS, '100.0'), twapLine(END_MS, '101.0')];
    // По записанному было бы Up; официальный эталон открытия выше финала
    expect(deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS, '200.0')?.label).toBe('Down');
  });

  it('непригодное официальное значение игнорируется в пользу записанного', () => {
    const lines = [twapLine(START_MS, '100.0'), twapLine(END_MS, '101.0')];
    const derived = deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS, 'NaN');

    expect(derived?.priceToBeat.value).toBe('100.0');
    expect(derived?.label).toBe('Up');
  });

  it('официальный эталон НЕ отменяет требования покрытия границы открытия', () => {
    // Наличие официального числа не доказывает, что ряд покрывает окно рынка
    const lines = [twapLine(END_MS, '101.0')];
    expect(
      deriveWinnerFromRecordedTwap(lines, FEED, START_MS, END_MS, '100.0'),
    ).toBeUndefined();
  });
});

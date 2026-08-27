/**
 * Ограниченное окно недавних venue-идентификаторов сделок.
 *
 * @remarks
 * Главный инвариант — ОГРАНИЧЕННОСТЬ: окно не имеет права расти вместе с
 * лентой сделок, иначе «дедуп» превратился бы в утечку памяти на весь срок
 * жизни процесса.
 */
import { describe, expect, it } from '@jest/globals';
import { DEFAULT_RECENT_TRADE_IDS_CAPACITY, RecentVenueTradeIds } from '../src/index.js';

describe('RecentVenueTradeIds', () => {
  it('пропускает новый идентификатор и отсекает повтор', () => {
    const seen = new RecentVenueTradeIds(8);
    expect(seen.registerIfNew('6617804453')).toBe(true);
    expect(seen.registerIfNew('6617804453')).toBe(false);
    expect(seen.registerIfNew('6617804454')).toBe(true);
  });

  it('никогда не превышает заданную ёмкость', () => {
    const seen = new RecentVenueTradeIds(16);
    for (let i = 0; i < 10_000; i++) {
      seen.registerIfNew(`trade-${i}`);
    }
    expect(seen.size).toBe(16);
  });

  it('вытесняет самые старые идентификаторы (FIFO)', () => {
    const seen = new RecentVenueTradeIds(3);
    seen.registerIfNew('a');
    seen.registerIfNew('b');
    seen.registerIfNew('c');
    // 'a' вытесняется четвёртым идентификатором
    seen.registerIfNew('d');
    expect(seen.registerIfNew('a')).toBe(true); // забыт → снова «новый»
    expect(seen.registerIfNew('d')).toBe(false); // ещё помнится
  });

  it('ловит повтор на дистанции, наблюдённой в реальном архиве', () => {
    // Замер на записанном raw-архиве: максимальная дистанция повтора —
    // 74 сделки того же инструмента, p95 = 50. Дефолтная ёмкость обязана
    // покрывать это с запасом
    const seen = new RecentVenueTradeIds();
    seen.registerIfNew('repeated');
    for (let i = 0; i < 74; i++) {
      seen.registerIfNew(`filler-${i}`);
    }
    expect(seen.registerIfNew('repeated')).toBe(false);
  });

  it('дефолтная ёмкость даёт запас над наблюдённым максимумом', () => {
    expect(DEFAULT_RECENT_TRADE_IDS_CAPACITY).toBeGreaterThanOrEqual(74 * 5);
  });

  it('отвергает бессмысленную ёмкость', () => {
    expect(() => new RecentVenueTradeIds(0)).toThrow(RangeError);
    expect(() => new RecentVenueTradeIds(-1)).toThrow(RangeError);
    expect(() => new RecentVenueTradeIds(1.5)).toThrow(RangeError);
  });
});

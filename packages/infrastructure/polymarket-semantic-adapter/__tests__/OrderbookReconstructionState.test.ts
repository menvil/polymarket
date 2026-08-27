/**
 * Реконструкция стакана: снапшот, дельты, desync, границы памяти.
 *
 * @remarks
 * Уровень тестируется ОТДЕЛЬНО от адаптера — это ядро, из которого выводятся
 * торговые решения, и его инварианты не должны зависеть от маршрутизации
 * событий.
 */
import { describe, expect, it, beforeEach } from '@jest/globals';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { asInstrumentId, asMarketId } from '@polymarket/ids';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import { OrderbookReconstructionState } from '../src/index.js';
import type { LevelDeltaInput, VendorBestPrices } from '../src/index.js';
import { MARKET_ID, TOKEN_A, TOKEN_B } from './support/fixtures.js';

const TOKEN: InstrumentId = asInstrumentId(TOKEN_A)!;
const OTHER_TOKEN: InstrumentId = asInstrumentId(TOKEN_B)!;
const MARKET: MarketId = asMarketId(MARKET_ID)!;

/**
 * Создаёт `Timestamp` для фикстуры.
 *
 * @param ms - Момент времени (epoch ms)
 * @returns `Timestamp` VO
 * @throws {Error} Если значение невалидно (дефект самой фикстуры)
 */
function ts(ms: number): Timestamp {
  const result = TimestampService.create(ms);
  if (!result.ok) throw new Error(`invalid fixture timestamp: ${String(ms)}`);
  return result.value;
}

const RECEIVED_AT: Timestamp = ts(1_787_751_722_800);
const VENUE_TS: Timestamp = ts(1_787_751_722_763);

/** Источник ничего не утверждает о верхушке — сверка не производится. */
const NO_BEST: VendorBestPrices = { bestBid: undefined, bestAsk: undefined };

let state: OrderbookReconstructionState;

beforeEach(() => {
  state = new OrderbookReconstructionState();
});

function snapshot(
  bids: readonly { price: string; size: string }[],
  asks: readonly { price: string; size: string }[],
  instrumentId: InstrumentId = TOKEN,
) {
  return state.applySnapshot(instrumentId, MARKET, bids, asks, RECEIVED_AT, VENUE_TS);
}

function deltas(
  input: readonly LevelDeltaInput[],
  best: VendorBestPrices = NO_BEST,
  instrumentId: InstrumentId = TOKEN,
) {
  return state.applyDeltas(instrumentId, input, best, RECEIVED_AT, VENUE_TS);
}

describe('полный снапшот', () => {
  it('строит canonical Orderbook с правильными уровнями, порядком и временем', () => {
    const outcome = snapshot(
      [
        { price: '0.48', size: '30' },
        { price: '0.50', size: '10' },
      ],
      [
        { price: '0.54', size: '8' },
        { price: '0.52', size: '7' },
      ],
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const book = outcome.book;
    expect(book.instrumentId).toBe(TOKEN);
    // Унаследованный контракт сущности: первое поле несёт marketId
    expect(String(book.marketId)).toBe(MARKET_ID);

    // bids по убыванию, asks по возрастанию — сортирует сама сущность
    expect(book.bids.map((level) => level.price.value().toString())).toEqual(['0.5', '0.48']);
    expect(book.asks.map((level) => level.price.value().toString())).toEqual(['0.52', '0.54']);
    expect(book.getBestBid()?.value().toString()).toBe('0.5');
    expect(book.getBestAsk()?.value().toString()).toBe('0.52');

    // Два РАЗНЫХ времени не смешиваются
    expect(book.venueTimestamp?.toNumber()).toBe(VENUE_TS.toNumber());
    expect(book.receivedAt.toNumber()).toBe(RECEIVED_AT.toNumber());
    expect(outcome.version).toBe(1);
  });

  it('ЗАМЕЩАЕТ прежнее состояние, а не сливает его с новым', () => {
    const wide = Array.from({ length: 10 }, (_, index) => ({
      price: `0.${String(40 + index).padStart(2, '0')}`,
      size: '5',
    }));
    snapshot(wide, [{ price: '0.60', size: '1' }]);

    const narrow = snapshot(
      [
        { price: '0.49', size: '2' },
        { price: '0.48', size: '3' },
      ],
      [{ price: '0.60', size: '1' }],
    );

    expect(narrow.ok).toBe(true);
    if (!narrow.ok) return;
    // Прежние 10 уровней обязаны исчезнуть — иначе это merge, а не snapshot
    expect(narrow.book.bids).toHaveLength(2);
    expect(narrow.book.bids.map((level) => level.price.value().toString())).toEqual([
      '0.49',
      '0.48',
    ]);
  });

  it('отбрасывает уровни с нулевым размером — «размер 0» и «уровня нет» тождественны', () => {
    const outcome = snapshot(
      [
        { price: '0.50', size: '0' },
        { price: '0.49', size: '4' },
      ],
      [],
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.book.bids).toHaveLength(1);
    expect(outcome.book.getBestBid()?.value().toString()).toBe('0.49');
  });

  it('версия инструмента растёт на каждый применённый снапшот', () => {
    expect(state.versionOf(TOKEN)).toBe(0);
    snapshot([], []);
    expect(state.versionOf(TOKEN)).toBe(1);
    snapshot([], []);
    expect(state.versionOf(TOKEN)).toBe(2);
  });
});

describe('дельты', () => {
  beforeEach(() => {
    snapshot([{ price: '0.50', size: '10' }], [{ price: '0.52', size: '7' }]);
  });

  it('задаёт АБСОЛЮТНЫЙ размер уровня, а не приращение', () => {
    const outcome = deltas([{ side: 'BID', price: '0.50', size: '25' }]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 25, а НЕ 35
    expect(outcome.book.bids[0]!.quantity.value().toString()).toBe('25');
  });

  it('размер 0 удаляет уровень', () => {
    const outcome = deltas([{ side: 'BID', price: '0.50', size: '0' }]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.book.bids).toHaveLength(0);
    expect(outcome.book.getBestBid()).toBeNull();
  });

  it('SELL меняет сторону ASK, а не BID', () => {
    const outcome = deltas([{ side: 'ASK', price: '0.53', size: '3' }]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.book.asks.map((level) => level.price.value().toString())).toEqual([
      '0.52',
      '0.53',
    ]);
    expect(outcome.book.bids).toHaveLength(1);
    expect(outcome.book.bids[0]!.price.value().toString()).toBe('0.5');
  });

  it('нормализует запись цены: "0.50" и "0.5" — один уровень', () => {
    const outcome = deltas([{ side: 'BID', price: '0.5', size: '42' }]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.book.bids).toHaveLength(1);
    expect(outcome.book.bids[0]!.quantity.value().toString()).toBe('42');
  });

  it('состояние инструментов независимо', () => {
    state.applySnapshot(
      OTHER_TOKEN,
      MARKET,
      [{ price: '0.30', size: '1' }],
      [],
      RECEIVED_AT,
      VENUE_TS,
    );
    deltas([{ side: 'BID', price: '0.50', size: '99' }]);

    const other = state.applyDeltas(OTHER_TOKEN, [], NO_BEST, RECEIVED_AT, VENUE_TS);
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.book.bids[0]!.quantity.value().toString()).toBe('1');
  });
});

describe('дельта до первого снапшота', () => {
  it('НЕ строит частичный стакан и сообщает NO_SNAPSHOT', () => {
    const outcome = deltas([{ side: 'BID', price: '0.50', size: '10' }]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('NO_SNAPSHOT');
    expect(state.has(TOKEN)).toBe(false);
  });
});

describe('desync', () => {
  beforeEach(() => {
    snapshot([{ price: '0.50', size: '10' }], [{ price: '0.52', size: '7' }]);
  });

  it('расхождение с объявленной источником верхушкой уводит инструмент в DESYNC', () => {
    const outcome = deltas([{ side: 'BID', price: '0.49', size: '5' }], {
      bestBid: '0.51', // источник утверждает недостижимое для нашей книги
      bestAsk: '0.52',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('DESYNC_DETECTED');
    expect(state.isDesynced(TOKEN)).toBe(true);
  });

  it('совпадение верхушки НЕ уводит в DESYNC (в т.ч. при иной записи числа)', () => {
    const outcome = deltas([{ side: 'BID', price: '0.51', size: '5' }], {
      bestBid: '0.5100',
      bestAsk: '0.52',
    });
    expect(outcome.ok).toBe(true);
    expect(state.isDesynced(TOKEN)).toBe(false);
  });

  it('источник объявил пустую сторону ("0"), а у нас уровни есть → DESYNC', () => {
    const outcome = deltas([{ side: 'BID', price: '0.50', size: '10' }], {
      bestBid: '0',
      bestAsk: '0.52',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('DESYNC_DETECTED');
  });

  it('источник объявил пустую сторону и у нас её нет → расхождения НЕТ', () => {
    const outcome = deltas([{ side: 'BID', price: '0.50', size: '0' }], {
      bestBid: '0',
      bestAsk: '0.52',
    });
    expect(outcome.ok).toBe(true);
    expect(state.isDesynced(TOKEN)).toBe(false);
  });

  it('любая запись нуля ("0.00", "0.0") трактуется как пустая сторона', () => {
    for (const zero of ['0', '0.0', '0.00', '00']) {
      state = new OrderbookReconstructionState();
      snapshot([{ price: '0.50', size: '10' }], []);
      const outcome = deltas([{ side: 'BID', price: '0.50', size: '0' }], {
        bestBid: zero,
        bestAsk: undefined,
      });
      expect(outcome.ok).toBe(true);
      expect(state.isDesynced(TOKEN)).toBe(false);
    }
  });

  it('НЕпригодное значение best (не цена и не ноль) НЕ уводит в DESYNC', () => {
    // "1" вне домена Price [0.0001, 0.9999], но это НЕ утверждение о пустоте:
    // трактовать его как пустоту значило бы останавливать исправную книгу
    const outcome = deltas([{ side: 'BID', price: '0.50', size: '10' }], {
      bestBid: '1',
      bestAsk: undefined,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(state.isDesynced(TOKEN)).toBe(false);
    // Но и «проверено» это не значит — факт фиксируется отдельно
    expect(outcome.unverifiedBest).toContain('not a usable price');
  });

  it('расхождение на ОДНОЙ стороне важнее непригодного значения на другой', () => {
    const outcome = deltas([{ side: 'BID', price: '0.49', size: '5' }], {
      bestBid: '1', // непригодно
      bestAsk: '0.99', // а вот здесь реальное расхождение
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('DESYNC_DETECTED');
    expect(state.isDesynced(TOKEN)).toBe(true);
  });

  it('успешная сверка не помечает результат как непроверенный', () => {
    const outcome = deltas([{ side: 'BID', price: '0.51', size: '5' }], {
      bestBid: '0.51',
      bestAsk: '0.52',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.unverifiedBest).toBeUndefined();
  });

  it('в состоянии DESYNC дельты не применяются', () => {
    deltas([{ side: 'BID', price: '0.49', size: '5' }], { bestBid: '0.51', bestAsk: '0.52' });
    const next = deltas([{ side: 'BID', price: '0.45', size: '1' }]);
    expect(next.ok).toBe(false);
    if (next.ok) return;
    expect(next.reason).toBe('DESYNCED');
  });

  it('новый authoritative book снимает DESYNC и возвращает публикацию', () => {
    deltas([{ side: 'BID', price: '0.49', size: '5' }], { bestBid: '0.51', bestAsk: '0.52' });
    expect(state.isDesynced(TOKEN)).toBe(true);

    const restored = snapshot([{ price: '0.51', size: '9' }], [{ price: '0.53', size: '4' }]);
    expect(restored.ok).toBe(true);
    expect(state.isDesynced(TOKEN)).toBe(false);
    if (!restored.ok) return;
    // Устаревшие уровни не сохраняются
    expect(restored.book.bids.map((level) => level.price.value().toString())).toEqual(['0.51']);

    const resumed = deltas([{ side: 'BID', price: '0.50', size: '2' }]);
    expect(resumed.ok).toBe(true);
  });
});

describe('невалидные данные', () => {
  beforeEach(() => {
    snapshot([{ price: '0.50', size: '10' }], [{ price: '0.52', size: '7' }]);
  });

  it('отрицательный размер отвергается, состояние не мутируется', () => {
    const outcome = deltas([{ side: 'BID', price: '0.50', size: '-5' }]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('INVALID_LEVEL');

    const after = deltas([]);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.book.bids[0]!.quantity.value().toString()).toBe('10');
  });

  it('цена вне домена рынка предсказаний отвергается', () => {
    const outcome = deltas([{ side: 'BID', price: '1.5', size: '5' }]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('INVALID_LEVEL');
  });

  it('плохой уровень В СЕРЕДИНЕ пачки не оставляет книгу полуприменённой', () => {
    const outcome = deltas([
      { side: 'BID', price: '0.49', size: '1' },
      { side: 'BID', price: 'nonsense', size: '1' },
      { side: 'BID', price: '0.47', size: '1' },
    ]);
    expect(outcome.ok).toBe(false);

    const after = deltas([]);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // Ни 0.49, ни 0.47 не должны были попасть в книгу
    expect(after.book.bids.map((level) => level.price.value().toString())).toEqual(['0.5']);
  });

  it('невалидный снапшот СОХРАНЯЕТ прежнее состояние', () => {
    const outcome = snapshot([{ price: '0.49', size: 'oops' }], []);
    expect(outcome.ok).toBe(false);

    const after = deltas([]);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.book.bids[0]!.price.value().toString()).toBe('0.5');
  });
});

describe('точность', () => {
  it('сохраняет неудобные десятичные значения без float-округления', () => {
    const outcome = snapshot(
      [
        { price: '0.123456789', size: '0.000000001' },
        { price: '0.0001', size: '123456789.123456789' },
      ],
      [{ price: '0.9999', size: '0.1' }],
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const bids = outcome.book.bids;
    expect(bids[0]!.price.value().toString()).toBe('0.123456789');
    expect(bids[0]!.quantity.value().toString()).toBe('1e-9');
    expect(bids[1]!.quantity.value().toString()).toBe('123456789.123456789');
    expect(outcome.book.asks[0]!.price.value().toString()).toBe('0.9999');
  });
});

describe('иммутабельность наружу', () => {
  it('потребитель не может изменить состояние реконструкции через выданный стакан', () => {
    const first = snapshot([{ price: '0.50', size: '10' }], []);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Попытка мутации выданной сущности не должна доходить до состояния
    expect(() => {
      (first.book as unknown as { bids: unknown }).bids = [];
    }).toThrow();

    const second = deltas([]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.book.bids).toHaveLength(1);
    // Каждое обновление — НОВЫЙ инстанс, а не тот же объект
    expect(second.book).not.toBe(first.book);
  });
});

describe('границы памяти', () => {
  it('forgetInstrument удаляет состояние одного инструмента', () => {
    snapshot([], []);
    expect(state.getStats().activeInstruments).toBe(1);
    expect(state.forgetInstrument(TOKEN)).toBe(true);
    expect(state.getStats().activeInstruments).toBe(0);
    expect(state.forgetInstrument(TOKEN)).toBe(false);
  });

  it('forgetMarket удаляет ОБЕ стороны рынка и возвращает их список', () => {
    snapshot([], [], TOKEN);
    snapshot([], [], OTHER_TOKEN);
    expect(state.getStats().activeInstruments).toBe(2);

    const forgotten = state.forgetMarket(MARKET);
    expect([...forgotten].sort()).toEqual([TOKEN, OTHER_TOKEN].sort());
    expect(state.getStats().activeInstruments).toBe(0);
    expect(state.forgetMarket(MARKET)).toEqual([]);
  });

  it('clear освобождает всё состояние', () => {
    snapshot([], [], TOKEN);
    snapshot([], [], OTHER_TOKEN);
    state.clear();
    expect(state.getStats()).toEqual({ activeInstruments: 0, desyncedInstruments: 0 });
  });

  it('stats считает рассинхронизированные инструменты', () => {
    snapshot([{ price: '0.50', size: '1' }], []);
    deltas([{ side: 'BID', price: '0.50', size: '1' }], { bestBid: '0.44', bestAsk: undefined });
    expect(state.getStats()).toEqual({ activeInstruments: 1, desyncedInstruments: 1 });
  });
});

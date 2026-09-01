/**
 * Тесты `buildCanonicalMarket` — сборка канонического Market из метаданных бота.
 *
 * @remarks
 * Функция дважды приезжала с дефектами, поэтому её контракт зафиксирован тестами:
 * выбор семейства, источник `startsAt`, номинал серии против измеренного окна
 * и все ветки честного отказа.
 */

import { describe, it, expect } from '@jest/globals';
import { unsafeInstrumentId, unsafeMarketId } from '@polymarket/ids';
import type { Market } from '@polymarket/market';
import {
  buildCanonicalMarket,
  FALLBACK_MARKET_DURATION_MS,
  type CanonicalMarketInput,
} from '../../src/bot/buildCanonicalMarket.js';

/** Окно модельного 5-минутного рынка: 09:50–09:55 */
const WINDOW_START_MS = Date.parse('2026-03-26T09:50:00Z');
const WINDOW_END_MS = Date.parse('2026-03-26T09:55:00Z');
const FIVE_MINUTES_MS = 5 * 60_000;

/**
 * Базовый вход: крипто-рынок Solana Up/Down с известным окном.
 *
 * @param overrides - Поля, которые нужно заменить
 * @returns {@link CanonicalMarketInput}
 */
function input(overrides: Partial<CanonicalMarketInput> = {}): CanonicalMarketInput {
  return {
    marketId: unsafeMarketId('0x786a9c251cbf57eac13a0def16095ecf09734b'),
    question: 'Solana Up or Down — March 26, 5:50AM-5:55AM ET?',
    instrumentId: unsafeInstrumentId('7147603170549100'),
    complementaryInstrumentId: unsafeInstrumentId('2299308841012200'),
    outcomeIndex: 0,
    expiresAtMs: WINDOW_END_MS,
    eventStartMs: WINDOW_START_MS,
    crypto: {
      symbol: 'sol/usd',
      eventStartMs: WINDOW_START_MS,
      eventEndMs: WINDOW_END_MS,
    },
    ...overrides,
  };
}

/**
 * Разворачивает Ok в тестах.
 *
 * @param overrides - Поля входа
 * @returns Собранный Market
 * @throws {Error} Если сборка вернула Err
 */
function build(overrides: Partial<CanonicalMarketInput> = {}): Market {
  const result = buildCanonicalMarket(input(overrides));
  if (!result.ok) throw new Error(`Expected Ok: ${result.error.message}`);
  return result.value;
}

describe('buildCanonicalMarket — расписание', () => {
  it('берёт startsAt из начала торгового окна', () => {
    expect(build().startsAt.toNumber()).toBe(WINDOW_START_MS);
  });

  it('5-минутный рынок имеет длительность 5 минут, а не сутки', () => {
    // Регрессия: раньше startsAt брался из events[0].startDate — даты создания
    // записи события, которая на реальном снапшоте оказалась суткой раньше.
    expect(build().duration().toNumber()).toBe(FIVE_MINUTES_MS);
  });

  it('без начала окна откатывается к expiresAt - FALLBACK', () => {
    const market = build({ eventStartMs: undefined, crypto: undefined });

    expect(market.startsAt.toNumber()).toBe(WINDOW_END_MS - FALLBACK_MARKET_DURATION_MS);
  });

  it('нефинитное начало окна трактуется как отсутствующее', () => {
    const market = build({ eventStartMs: NaN, crypto: undefined });

    expect(market.startsAt.toNumber()).toBe(WINDOW_END_MS - FALLBACK_MARKET_DURATION_MS);
  });

  it('начало окна не раньше экспирации — Err, а не сдвиг', () => {
    const result = buildCanonicalMarket(input({ eventStartMs: WINDOW_END_MS }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('startsAt');
  });
});

describe('buildCanonicalMarket — семейство', () => {
  it('крипто-метаданные есть → CRYPTO_UP_DOWN со спецификацией', () => {
    const market = build();

    expect(market.family).toBe('CRYPTO_UP_DOWN');
    expect(market.crypto).toEqual({ asset: 'sol', duration: FIVE_MINUTES_MS });
  });

  it('крипто-метаданных нет → BINARY_OUTCOME без спецификации', () => {
    const market = build({ crypto: undefined });

    expect(market.family).toBe('BINARY_OUTCOME');
    expect('crypto' in market).toBe(false);
  });

  it('номинал серии берётся из окна события, а не из расписания рынка', () => {
    // Площадка сдвинула окно конкретного рынка, серия осталась 5-минутной
    const market = build({ expiresAtMs: WINDOW_END_MS + 1_000 });

    expect(market.crypto?.duration).toBe(FIVE_MINUTES_MS);
    expect(market.duration().toNumber()).toBe(FIVE_MINUTES_MS + 1_000);
  });

  it('неразбираемый крипто-символ — Err, а не «btc по умолчанию»', () => {
    const result = buildCanonicalMarket(input({
      crypto: { symbol: '  ', eventStartMs: WINDOW_START_MS, eventEndMs: WINDOW_END_MS },
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('crypto.asset');
  });
});

describe('buildCanonicalMarket — исходы', () => {
  it.each([
    [0, 'Up', 'Down'],
    [1, 'Down', 'Up'],
  ])('outcomeIndex=%s ставит торгуемый инструмент на свою позицию', (index, traded, other) => {
    const market = build({ outcomeIndex: index as 0 | 1 });

    expect(market.outcomes[index as 0 | 1].label).toBe(traded);
    expect(market.outcomes[index as 0 | 1].instrumentId).toBe('7147603170549100');
    expect(market.outcomes[1 - (index as 0 | 1)].label).toBe(other);
    expect(market.outcomes[1 - (index as 0 | 1)].instrumentId).toBe('2299308841012200');
  });

  it('без комплементарного инструмента — Err, второй исход не выдумывается', () => {
    const result = buildCanonicalMarket(input({ complementaryInstrumentId: undefined }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('complementaryInstrumentId');
  });
});

describe('buildCanonicalMarket — прочее', () => {
  it.each([
    ['отсутствующий', undefined],
    ['пустой', '   '],
  ])('%s question заменяется идентификатором рынка', (_label, question) => {
    const market = build({ question });

    expect(market.question).toBe('0x786a9c251cbf57eac13a0def16095ecf09734b');
  });

  it('рынок создаётся в состоянии ACTIVE', () => {
    expect(build().state.status).toBe('ACTIVE');
  });
});

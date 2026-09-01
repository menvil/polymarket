/**
 * Фикстура канонического `Market` для интеграционных тестов.
 *
 * @remarks
 * Тесты регистрируют стратегию через `StrategyScheduler.register()`, который
 * принимает настоящий `Market`. Раньше здесь стоял каст неполного объекта
 * (`{ expiresAt } as Market`) — ровно та заглушка, из-за которой стратегия,
 * читающая `market.outcomes`, молча уходила в fallback.
 *
 * Хелпер строит рынок тем же production-кодом (`buildCanonicalMarket`), поэтому
 * интеграционные тесты заодно проверяют и его: если сборка канонического рынка
 * сломается, тесты упадут здесь, а не в проде.
 */

import { buildCanonicalMarket } from '../../src/bot/buildCanonicalMarket.js';
import type { Market } from '@polymarket/market';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { OutcomeIndex } from '@polymarket/market';

/** Длительность тестового рынка — сутки от «сейчас» */
const TEST_MARKET_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Параметры тестового рынка
 */
export interface TestMarketOptions {
  /** ID рынка из meta снапшота */
  readonly marketId: MarketId;
  /** Инструмент торгуемого исхода */
  readonly instrumentId: InstrumentId;
  /** Инструмент противоположного исхода */
  readonly complementaryInstrumentId: InstrumentId;
  /** Позиция торгуемого исхода: 0 = Up, 1 = Down */
  readonly outcomeIndex: OutcomeIndex;
  /** Момент отсчёта окна рынка (epoch ms), по умолчанию `Date.now()` */
  readonly nowMs?: number;
}

/**
 * Собирает канонический `Market` для интеграционного теста
 *
 * @param options - Идентификаторы из meta-строки снапшота
 * @returns Готовый `Market` семейства `CRYPTO_UP_DOWN`
 * @throws {Error} Если `buildCanonicalMarket` вернул `Err` — значит, сломалась
 *   сборка канонического рынка, и тест обязан это показать
 *
 * @example
 * ```typescript
 * const market = buildTestMarket({
 *   marketId, instrumentId, complementaryInstrumentId, outcomeIndex: 1,
 * });
 * await engine.scheduler.register({ strategy, instrumentId, asset, accountId, market });
 * ```
 */
export function buildTestMarket(options: TestMarketOptions): Market {
  const nowMs = options.nowMs ?? Date.now();
  const expiresAtMs = nowMs + TEST_MARKET_DURATION_MS;
  const result = buildCanonicalMarket({
    marketId: options.marketId,
    question: `Backtest market ${String(options.marketId)}`,
    instrumentId: options.instrumentId,
    complementaryInstrumentId: options.complementaryInstrumentId,
    outcomeIndex: options.outcomeIndex,
    expiresAtMs,
    startsAtMs: nowMs,
    eventStartMs: nowMs,
    crypto: { symbol: 'btc/usd', eventStartMs: nowMs, eventEndMs: expiresAtMs },
  });
  if (!result.ok) {
    throw new Error(`Failed to build test market: ${result.error.message}`);
  }
  return result.value;
}

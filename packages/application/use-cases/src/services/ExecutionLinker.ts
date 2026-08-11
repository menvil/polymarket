/**
 * ExecutionLinker — связывает Fill с соответствующим рыночным Trade.
 *
 * @remarks
 * Fill (наше исполнение) и Trade (публичный рыночный принт, `@polymarket/trade`)
 * описывают один и тот же on-chain факт, но приходят по разным каналам
 * (user-specific fill feed vs public trade tape) — `Fill.venueTradeId`
 * спроектирован для этой сшивки (`ExecutionMetadata.venueTradeId`), но до Этапа 7
 * никто её не выполнял.
 *
 * ### Почему fuzzy-matching, а не точный lookup по ключу:
 * `TradeIndexCollector` (`@polymarket/market-state`, Этап 2) уже документирует:
 * `transaction_hash` недоступен нигде в реальной цепочке поставки данных
 * Polymarket, поэтому `Trade.id` (composite key) и `Fill.venueTradeId` (bare
 * txHash-или-undefined) НИКОГДА не пересекаются для реального трафика. Матчинг —
 * через `TradeIndexCollector.findMatch()`: (tokenId, price, size — точное
 * совпадение) + временное окно (допуск на relative delay между каналами).
 *
 * ### Текущий охват — только логирование, не персистентность:
 * `ExecutionMetadata` (где живёт `venueTradeId`) сериализуется через
 * `FillMapper.toSnapshot(fill, metadata)`, но эта функция не вызывается нигде в
 * реальном коде — Fill/ExecutionMetadata персистентность не построена (не в
 * объёме этой миграции). Результат матчинга здесь логируется (found/not-found +
 * `Trade.id` при находке) — делает `TradeIndexCollector`'s API реально
 * вызываемым (не мёртвый код зовёт мёртвый код) и даёт видимость реального
 * match-rate на трафике. Когда появится персистентность — результат `link()`
 * готов для подключения к ней.
 *
 * @example
 * ```typescript
 * const linker = new ExecutionLinker({ tradeIndex, logger });
 * // В ProcessFillUseCase, рядом с ledgerService.recordFill(fill):
 * linker.link(fill);
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { Fill } from '@polymarket/fill';
import type { TradeIndexCollector } from '@polymarket/market-state';

/** Ширина окна поиска по умолчанию (ms) — допуск на relative delay между каналами. */
const DEFAULT_MATCH_WINDOW_MS = 30_000;

/** Зависимости ExecutionLinker. */
export interface ExecutionLinkerDeps {
  /** Индекс построенных рыночных Trade (см. `@polymarket/market-state`). */
  readonly tradeIndex: TradeIndexCollector;
  /** Logger (дочерний контекст 'ExecutionLinker' добавляется автоматически). */
  readonly logger: ILogger;
}

/**
 * Связывает Fill с рыночным Trade через fuzzy/windowed matching.
 *
 * @remarks
 * Best-effort и не критичен для основного потока обработки fill: `link()`
 * никогда не бросает и не возвращает `Result` — сбой матчинга (в т.ч. любое
 * неожиданное исключение внутри) логируется как debug/warn и не влияет на
 * исход `ProcessFillUseCase.execute()`.
 */
export class ExecutionLinker {
  private readonly _tradeIndex: TradeIndexCollector;
  private readonly _logger: ILogger;

  /**
   * @param deps - Зависимости (индекс трейдов + logger)
   */
  constructor(deps: ExecutionLinkerDeps) {
    this._tradeIndex = deps.tradeIndex;
    this._logger = deps.logger.child({ component: 'ExecutionLinker' });
  }

  /**
   * Пытается найти рыночный Trade, соответствующий данному Fill, и логирует исход.
   *
   * @param fill - Исполнение ордера для сшивки
   * @param windowMs - Ширина окна поиска назад от `fill.timestamp` (по умолчанию
   *   {@link DEFAULT_MATCH_WINDOW_MS})
   *
   * @remarks
   * Матчинг — по (`fill.tokenId`, `fill.price`, `fill.size`) с точным
   * совпадением, плюс временное окно. Используется `fill.price` (реальная цена
   * исполнения), а не цена ордера — Trade тоже отражает реально исполненную
   * цену, обе стороны одного on-chain факта должны совпасть точно.
   */
  public link(fill: Fill, windowMs: number = DEFAULT_MATCH_WINDOW_MS): void {
    try {
      const matched = this._tradeIndex.findMatch(fill.tokenId, fill.price, fill.size, fill.timestamp, windowMs);
      if (matched) {
        this._logger.debug('Fill linked to market trade', {
          fillId: String(fill.id),
          tradeId: String(matched.id),
        });
      } else {
        this._logger.debug('No matching market trade found for fill', {
          fillId: String(fill.id),
        });
      }
    } catch (err) {
      this._logger.warn('ExecutionLinker.link threw unexpectedly — ignored (best-effort)', {
        fillId: String(fill.id),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

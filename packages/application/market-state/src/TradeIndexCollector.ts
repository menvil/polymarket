/**
 * Коллектор индекса трейдов по VenueTradeId (Trade Index Collector)
 *
 * @remarks
 * **Пассивный буфер** построенных `Trade` entity из `@polymarket/trade`, с retention
 * через `RollingWindow<Trade>` (`@polymarket/rolling-window`). Подпиской владеет
 * `MarketDataStore` — он строит `Trade` через `TradeMapper.fromParsedTrade()` на каждом
 * `TRADE_RECEIVED` и пишет сюда через `record()`. Как и `BookDepthCollector`/
 * `TradeTapeCollector`, у коллектора нет `start()/stop()` и зависимости от EventBus.
 *
 * ### Назначение:
 * Единый источник построенных рыночных `Trade` для будущего `ExecutionLinker`
 * (Этап 7 плана миграции) — при обработке `Fill` он будет искать соответствующий
 * рыночный `Trade` через `get()`.
 *
 * ### ⚠️ Известное ограничение — Trade.id vs Fill.venueTradeId:
 * `transaction_hash` недоступен нигде в реальной цепочке поставки данных Polymarket
 * (ни в live WS DTO, ни в backtest replay — см. TSDoc `TradeMapper.fromParsedTrade`).
 * Из-за этого `Trade.id`, построенный здесь, **всегда** составной ключ
 * (`marketId_assetId_ts_price_size`), а `Fill.venueTradeId` (`FillMapper.ts`) — всегда
 * bare `transaction_hash` либо `undefined`, без composite-фолбэка. Пространства значений
 * этих двух ключей для реального трафика **не пересекаются никогда** — точный lookup
 * `index.get(fill.venueTradeId)` не найдёт ничего для реальных данных. Это не баг этого
 * класса — существующее свойство уже смёрженного `TradeMapper`/`FillMapper` кода,
 * которое Этап 2 впервые делает не-inert (раньше оба маппера были мёртвым кодом).
 * `ExecutionLinker` должен с самого начала проектировать fuzzy/windowed matching
 * (`tokenId` + price + size + временное окно), а не точный lookup по ключу.
 *
 * ### Устройство: одна RollingWindow на весь стор, не per-instrument.
 * В отличие от `BookDepthCollector`/`TradeTapeCollector` (`Map<InstrumentId, ...>`,
 * отдельная история на каждый инструмент), этот класс — **один** глобальный
 * `RollingWindow<Trade>`: `ExecutionLinker` ищет по `VenueTradeId` напрямую, без
 * привязки к конкретному инструменту как входной точке. `get()` — линейный скан
 * по окну (не отдельный `Map`-индекс): `RollingWindow` не даёт callback на вытеснение,
 * поэтому отдельный `Map<VenueTradeId, Trade>` неизбежно рассинхронизировался бы с
 * вытесненными элементами (утечка памяти). При типичных размерах окна (тысячи
 * элементов) и частоте вызовов `get()` (на каждый Fill — на порядки реже, чем
 * `record()` на каждый рыночный трейд) линейный скан — оправданный выбор простоты
 * и корректности над преждевременной оптимизацией.
 *
 * ### Отличие от BookDepthCollector/TradeTapeCollector: без shallow-конструктора.
 * Оба соседа исторически (throw-based легаси) проверяли в конструкторе только
 * "хотя бы одно поле задано", а полная проверка диапазонов происходила лениво внутри
 * `OrderBookHistory.create()`/`TradeTape.create()` на первом живом событии — фикс на
 * "surface at construction" добавлен им отдельно в Этапе 2. Этот класс — новый, без
 * такого легаси: полная валидация retention policy приходит сразу и полностью через
 * `RollingWindow.create()`'s `Result`, конструктор `TradeIndexCollector` не нужен как
 * отдельная точка проверки.
 *
 * @example
 * ```typescript
 * const indexResult = TradeIndexCollector.create({ maxCount: 5000, maxAgeMs: 600_000 }, clock);
 * if (!indexResult.ok) throw indexResult.error;
 * const index = indexResult.value;
 *
 * index.record(trade);
 *
 * // Почти всегда undefined для реального трафика — см. ограничение выше
 * const found = index.get(fill.venueTradeId);
 * ```
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type { ValidationError } from '@polymarket/errors';
import type { IClock } from '@polymarket/time';
import type { VenueTradeId } from '@polymarket/ids';
import { RollingWindow, type RetentionPolicy } from '@polymarket/rolling-window';
import type { Trade } from '@polymarket/trade';

/**
 * Политика хранения индекса трейдов.
 *
 * @remarks
 * Псевдоним для `RetentionPolicy` из `@polymarket/rolling-window`. Хотя бы одно
 * поле должно быть задано.
 */
export type TradeIndexCollectorConfig = RetentionPolicy;

/**
 * Коллектор индекса рыночных трейдов по `VenueTradeId`.
 *
 * @remarks
 * Создаётся через `TradeIndexCollector.create(config, clock)`. `record()`
 * автоматически вытесняет устаревшие записи согласно политике (делегировано
 * `RollingWindow`).
 */
export class TradeIndexCollector {
  private constructor(private readonly _window: RollingWindow<Trade>) {}

  /**
   * Создаёт новый индекс трейдов с заданной политикой хранения.
   *
   * @param config - Политика хранения (maxCount и/или maxAgeMs)
   * @param clock - Источник времени для `RollingWindow`
   * @returns `Result` с новым `TradeIndexCollector` либо `ValidationError`, если
   *   политика невалидна
   *
   * @example
   * ```typescript
   * const result = TradeIndexCollector.create({ maxCount: 5000 }, clock);
   * if (!result.ok) throw result.error;
   * const index = result.value;
   * ```
   */
  public static create(
    config: TradeIndexCollectorConfig,
    clock: IClock,
  ): Result<TradeIndexCollector, ValidationError> {
    const windowResult = RollingWindow.create<Trade>(
      config,
      clock,
      (trade) => trade.timestamp.toNumber(),
    );
    if (!windowResult.ok) {
      return Err(windowResult.error);
    }
    return Ok(new TradeIndexCollector(windowResult.value));
  }

  /**
   * Добавляет построенный Trade в индекс.
   *
   * @param trade - Рыночный трейд для индексации
   *
   * @remarks
   * Вытеснение (по возрасту и/или количеству) делегировано `RollingWindow.append()`.
   */
  public record(trade: Trade): void {
    this._window.append(trade);
  }

  /**
   * Ищет Trade по VenueTradeId.
   *
   * @param id - VenueTradeId для поиска (обычно `trade.id`)
   * @returns Trade или `undefined`, если не найден в текущем окне
   *
   * @remarks
   * ⚠️ См. известное ограничение в TSDoc класса: для реального трафика
   * `fill.venueTradeId` почти никогда не совпадёт с ключом, под которым Trade
   * был проиндексирован здесь (composite key vs bare txHash).
   */
  public get(id: VenueTradeId): Trade | undefined {
    return this._window.getAll().find((trade) => trade.id === id);
  }

  /**
   * Возвращает количество трейдов в индексе.
   *
   * @returns Текущий размер окна
   */
  public size(): number {
    return this._window.size();
  }

  /**
   * Проверяет, пуст ли индекс.
   *
   * @returns `true`, если трейдов ещё не было
   */
  public isEmpty(): boolean {
    return this._window.isEmpty();
  }
}

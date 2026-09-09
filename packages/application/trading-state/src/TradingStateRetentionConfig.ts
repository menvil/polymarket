/**
 * Сколько уже полученных наблюдений держать в оперативной памяти.
 *
 * @remarks
 * Это НЕ `Policy`. Policy отвечает на вопрос «какие источники и рынки мы
 * слушаем» — то есть управляет подписками. Retention отвечает на другой
 * вопрос: «сколько из уже пришедшего хранить». Смешивать их нельзя: смена
 * глубины истории не должна затрагивать подписки, и наоборот.
 *
 * Значений по умолчанию здесь намеренно НЕТ. Ядро получает конфиг явно:
 * «15 минут / 100000 записей», зашитые в библиотеку, стали бы невидимым
 * production-решением, которое никто не выбирал.
 *
 * Все политики проверяются при создании состояния, а не при первом живом
 * событии — иначе неверная конфигурация всплыла бы посреди торгов.
 */
import type { RetentionPolicy } from '@polymarket/rolling-window';

/** Глубина рядов для одного набора инструментов. */
export interface InstrumentRetentionConfig {
  /** История верхушки стакана (`BOOK_UPDATED`) */
  readonly topOfBooks: RetentionPolicy;
  /** История полных снимков стакана (`BOOK_DEPTH`) */
  readonly books: RetentionPolicy;
  /** История публичных сделок (`TRADE_RECEIVED`) */
  readonly trades: RetentionPolicy;
}

/**
 * Полная конфигурация хранения hot state.
 *
 * @remarks
 * Рыночные и shared-ряды настраиваются отдельно: данные площадки живут
 * дольше и приходят чаще, чем стакан одного пятиминутного рынка, и
 * навязывать им общую глубину значило бы либо переплатить памятью, либо
 * потерять нужную историю.
 *
 * @example
 * ```typescript
 * const retention: TradingStateRetentionConfig = {
 *   market: {
 *     topOfBooks: { maxCount: 512 },
 *     books:      { maxCount: 64 },
 *     trades:     { maxCount: 256, maxAgeMs: 600_000 },
 *   },
 *   shared: {
 *     topOfBooks: { maxAgeMs: 300_000 },
 *     books:      { maxCount: 32 },
 *     trades:     { maxAgeMs: 900_000 },
 *   },
 *   referencePrices: { maxCount: 1_024 },
 * };
 * ```
 */
export interface TradingStateRetentionConfig {
  /** Ряды инструментов, принадлежащих конкретному рынку */
  readonly market: InstrumentRetentionConfig;
  /** Ряды инструментов площадок вне рынка (CEX и подобные) */
  readonly shared: InstrumentRetentionConfig;
  /** Ряды референсных цен */
  readonly referencePrices: RetentionPolicy;
}

/** Все политики конфига с путями — для проверки при создании состояния. */
export function retentionPolicyEntries(
  config: TradingStateRetentionConfig,
): ReadonlyArray<readonly [string, RetentionPolicy]> {
  return [
    ['market.topOfBooks', config.market.topOfBooks],
    ['market.books', config.market.books],
    ['market.trades', config.market.trades],
    ['shared.topOfBooks', config.shared.topOfBooks],
    ['shared.books', config.shared.books],
    ['shared.trades', config.shared.trades],
    ['referencePrices', config.referencePrices],
  ];
}

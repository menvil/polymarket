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
 *   market: { books: { maxCount: 64 }, trades: { maxCount: 256, maxAgeMs: 600_000 } },
 *   shared: { books: { maxCount: 32 }, trades: { maxAgeMs: 900_000 } },
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
    ['market.books', config.market.books],
    ['market.trades', config.market.trades],
    ['shared.books', config.shared.books],
    ['shared.trades', config.shared.trades],
    ['referencePrices', config.referencePrices],
  ];
}

/**
 * Делает собственную неизменяемую копию конфигурации.
 *
 * @param config - Конфигурация, переданная вызывающим
 * @returns Копия, на которую внешний код не может повлиять
 *
 * @remarks
 * `readonly` в TypeScript — свойство ТИПА, а не объекта: вызывающий может
 * держать mutable-ссылку на тот же литерал и изменить `maxCount` после
 * того, как конфигурация уже проверена и по ней созданы ряды. Тогда
 * поведение рантайма поменялось бы без единого события.
 *
 * Поэтому значения копируются, а результат замораживается. `RollingWindow`
 * получает уже нашу копию политики, а не чужую ссылку.
 *
 * @example
 * ```typescript
 * const policy = { maxCount: 100 };
 * const owned = freezeRetentionConfig({ market: { books: policy, … }, … });
 * policy.maxCount = 1;          // на состояние больше не влияет
 * ```
 */
export function freezeRetentionConfig(
  config: TradingStateRetentionConfig,
): TradingStateRetentionConfig {
  const policy = (source: RetentionPolicy): RetentionPolicy =>
    Object.freeze({
      ...(source.maxCount === undefined ? {} : { maxCount: source.maxCount }),
      ...(source.maxAgeMs === undefined ? {} : { maxAgeMs: source.maxAgeMs }),
    });

  const instruments = (source: InstrumentRetentionConfig): InstrumentRetentionConfig =>
    Object.freeze({ books: policy(source.books), trades: policy(source.trades) });

  return Object.freeze({
    market: instruments(config.market),
    shared: instruments(config.shared),
    referencePrices: policy(config.referencePrices),
  });
}

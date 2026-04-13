import type { CexRecordSink } from './CexTypes.js';

/**
 * Конфигурация одной биржи в составе коллектора.
 */
export interface CexExchangeConfig {
  /**
   * Идентификатор биржи в ccxt.pro (напр. "binance").
   * Если не задан — используется ключ в словаре `exchanges`.
   */
  readonly exchangeId?: string;
  /** Тип рынка: spot, futures или swap. */
  readonly type: 'spot' | 'futures' | 'swap';
  /** Список символов для наблюдения (напр. ["BTC/USD", "ETH/USD"]). */
  readonly symbols: readonly string[];
  /** Подписываться на обновления стакана ордеров. */
  readonly orderbook: boolean;
  /** Подписываться на поток сделок. */
  readonly trades: boolean;
  /** Глубина стакана (кол-во уровней). Default: 10. */
  readonly obDepth?: number;
  /**
   * Интервал планового перезапуска WebSocket-соединения (ms).
   * Default: 2 часа.
   */
  readonly restartIntervalMs?: number;
  /**
   * Метод получения стакана:
   * - `watch` — WebSocket (рекомендуется, если биржа поддерживает).
   * - `fetch` — REST polling.
   * Default: автоопределение по ccxt.pro capabilities.
   */
  readonly obMethod?: 'watch' | 'fetch';
}

/**
 * Корневая конфигурация `CexCollectorService`.
 *
 * @remarks
 * Определяет набор бирж для наблюдения, параметры записи на диск
 * и список callback-потребителей данных в реальном времени.
 *
 * @example
 * ```typescript
 * const config: CexCollectorConfig = {
 *   exchanges: {
 *     binance: {
 *       type: 'futures',
 *       symbols: ['BTC/USD'],
 *       orderbook: true,
 *       trades: true,
 *     },
 *   },
 *   outputDir: './snapshots',
 *   compression: 'gzip',
 *   windowMinutes: 5,
 * };
 * ```
 */
export interface CexCollectorConfig {
  /** Словарь бирж: ключ используется как exchangeId по умолчанию. */
  readonly exchanges: Readonly<Record<string, CexExchangeConfig>>;
  /**
   * Директория для записи снапшотов на диск.
   * Если не задана — запись на диск отключена.
   */
  readonly outputDir?: string;
  /** Алгоритм сжатия файлов после ротации. Default: "gzip". */
  readonly compression?: 'none' | 'gzip';
  /**
   * Размер временного окна для ротации файлов (минуты).
   * Default: 5.
   */
  readonly windowMinutes?: number;
  /**
   * Максимальный размер буфера записей перед принудительным flush (штук).
   * Default: 200.
   */
  readonly bufferSize?: number;
  /**
   * Интервал периодического flush буфера на диск (ms).
   * Default: 5000.
   */
  readonly flushIntervalMs?: number;
  /**
   * Список callback-получателей нормализованных событий в реальном времени.
   * Вызываются синхронно при каждой новой записи.
   */
  readonly sinks?: readonly CexRecordSink[];
}

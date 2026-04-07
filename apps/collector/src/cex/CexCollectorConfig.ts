/**
 * Конфигурация сборщика данных с централизованных бирж (CEX).
 *
 * @remarks
 * Каждая биржа описывается ключом в `exchanges` (имя биржи в ccxt,
 * например `'binance'`, `'bybit'`). Добавление новой биржи = одна запись
 * в конфиге, ничего в коде.
 *
 * @example
 * ```typescript
 * const config: CexCollectorConfig = {
 *   outputDir: './data',
 *   compression: 'gzip',
 *   exchanges: {
 *     binance: {
 *       type: 'spot',
 *       symbols: ['BTC/USDT', 'ETH/USDT'],
 *       orderbook: true,
 *       trades: true,
 *       obDepth: 10,
 *     },
 *     bybit: {
 *       type: 'futures',
 *       symbols: ['BTC/USDT'],
 *       orderbook: true,
 *       trades: false,
 *     },
 *   },
 * };
 * ```
 */

/**
 * Конфигурация одной биржи.
 */
export interface CexExchangeConfig {
  /**
   * Тип рынка биржи.
   * - `'spot'` — спотовый рынок
   * - `'futures'` — фьючерсы
   * - `'swap'` — бессрочные контракты
   */
  readonly type: 'spot' | 'futures' | 'swap';

  /**
   * Список символов для подписки.
   * Формат ccxt: `'BTC/USDT'`, `'ETH/USDT'`.
   */
  readonly symbols: readonly string[];

  /** Собирать ли снапшоты ордербука. */
  readonly orderbook: boolean;

  /** Собирать ли публичные трейды. */
  readonly trades: boolean;

  /**
   * Глубина ордербука (количество уровней bid/ask).
   * @defaultValue 10
   */
  readonly obDepth?: number;

  /**
   * Интервал принудительного перезапуска WS-соединения в мс.
   * Защита от hung orderbooks при длительных сессиях.
   * @defaultValue 7_200_000 (2 часа)
   */
  readonly restartIntervalMs?: number;

  /**
   * Метод получения ордербука.
   * - `'watch'` — WebSocket (`watchOrderBook`), минимальная задержка
   * - `'fetch'` — REST polling (`fetchOrderBook`), для бирж без WS поддержки
   * - не задан — авто-детект: `watch` если биржа поддерживает, иначе `fetch`
   *
   * ccxt управляет rate limits автоматически при `fetch` (enableRateLimit=true).
   */
  readonly obMethod?: 'watch' | 'fetch';
}

/**
 * Конфигурация CEX коллектора.
 */
export interface CexCollectorConfig {
  /**
   * Конфигурация бирж.
   * Ключ — имя биржи в ccxt (например `'binance'`, `'bybit'`).
   */
  readonly exchanges: Readonly<Record<string, CexExchangeConfig>>;

  /**
   * Директория для записи файлов.
   * Структура: `outputDir/YYYY-MM-DD/{exchange}/{symbol__{HHMM}}.jsonl(.gz)`
   */
  readonly outputDir: string;

  /**
   * Режим сжатия завершённых 5-минутных файлов.
   * - `'none'` — без сжатия
   * - `'gzip'` — gzip после завершения окна
   */
  readonly compression: 'none' | 'gzip';

  /**
   * Размер окна ротации файлов в минутах.
   * @defaultValue 5
   */
  readonly windowMinutes?: number;

  /**
   * Размер буфера событий до принудительного сброса на диск.
   * @defaultValue 200
   */
  readonly bufferSize?: number;

  /**
   * Интервал периодического сброса буфера в мс.
   * @defaultValue 5_000
   */
  readonly flushIntervalMs?: number;
}

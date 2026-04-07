/**
 * Конфигурация сервиса сбора рыночных данных.
 *
 * @remarks
 * Определяет параметры подключения к Polymarket WebSocket и настройки
 * записи данных на диск. Используется в `CollectorService` для инициализации
 * `DataRecorder` и `MarketDataFeedAdapter`.
 *
 * Значения по умолчанию:
 * - `compression`: `'none'` — без сжатия (для удобства отладки)
 * - `bufferSize`: 100 событий (совпадает с `DEFAULT_RECORDER_CONFIG`)
 * - `flushIntervalMs`: 10 000 мс (сброс буфера раз в 10 секунд)
 * - `wsUrl`: официальный Polymarket market-channel endpoint
 *
 * @example
 * ```typescript
 * const config: CollectorConfig = {
 *   outputDir: './data',
 *   compression: 'gzip',
 *   bufferSize: 200,
 *   flushIntervalMs: 5_000,
 *   wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
 *   tokenIds: [
 *     '67704255197116168826604911233626301865010283966205730455742704536521111535950',
 *     '28257334928283890303635192969230584167951485435421345229067758649928042311681',
 *   ],
 * };
 * ```
 */
export interface CollectorConfig {
  /**
   * Директория для записи файлов снапшотов.
   * Структура: `outputDir/YYYY-MM-DD/{question}___{marketId}.jsonl`
   */
  readonly outputDir: string;

  /**
   * Режим сжатия файлов.
   * - `'none'` — без сжатия (файл остаётся как `.jsonl`)
   * - `'gzip'` — сжатие при финализации рынка
   */
  readonly compression: 'none' | 'gzip';

  /**
   * Количество событий в буфере до принудительного сброса на диск.
   * @defaultValue 100
   */
  readonly bufferSize?: number;

  /**
   * Интервал периодического сброса буфера в миллисекундах.
   * @defaultValue 10_000
   */
  readonly flushIntervalMs?: number;

  /**
   * URL Polymarket WebSocket endpoint.
   * @defaultValue 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
   */
  readonly wsUrl?: string;

  /**
   * Список token ID для подписки на рыночные данные.
   * Каждый token ID — это YES или NO outcome token конкретного рынка.
   */
  readonly tokenIds: readonly string[];

  /**
   * Поддиректория источника внутри date-папки.
   * @defaultValue `'polymarket'`
   * @example `'polymarket'` → `outputDir/YYYY-MM-DD/polymarket/`
   */
  readonly sourceSubDir?: string;
}

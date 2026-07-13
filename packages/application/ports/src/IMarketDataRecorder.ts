/**
 * Порт: запись сырых рыночных данных на диск.
 *
 * @remarks
 * Dependency Inversion — `MarketDataFeedAdapter` зависит от этого интерфейса,
 * а не от конкретной реализации (`DataRecorder` в `@polymarket/data-collection`).
 *
 * ### Назначение:
 * Перехватывает сырые WS-события до их преобразования в доменные объекты
 * и записывает их на диск для последующего воспроизведения в бектесте.
 *
 * ### Жизненный цикл рынка:
 * ```
 * registerMarket(meta)          ← при открытии рынка
 * recordEvent(tokenId, raw)     ← при каждом WS-событии (fire-and-forget)
 * finalizeMarket(id, reason)    ← при истечении/остановке
 * close()                       ← при завершении процесса
 * ```
 *
 * ### Гарантии:
 * - `recordEvent` синхронный и никогда не бросает — не блокирует trading path
 * - Ошибки буферизации логируются внутри реализации
 * - `finalizeMarket` и `close` — асинхронные, могут бросить при ошибке I/O
 *
 * Реализация: `DataRecorder` в `@polymarket/data-collection`.
 *
 * Используется:
 * - `MarketDataFeedAdapter` — `recordEvent()` при каждом входящем WS-сообщении
 * - `CollectorService` — `registerMarket()` / `finalizeMarket()` / `close()`
 *
 * @example
 * ```typescript
 * // В MarketDataFeedAdapter:
 * this._deps.recorder?.recordEvent(tokenId, rawMessage);
 *
 * // В CollectorService при открытии рынка:
 * recorder.registerMarket({
 *   marketId, question,
 *   tokenIds: ['0xyes...', '0xno...'],
 *   expiresAt: market.expiresAt,
 * });
 * ```
 */

import type { MarketId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';

/**
 * Метаданные рынка для регистрации в рекордере.
 */
export interface MarketMeta {
  /** ID рынка (conditionId) */
  readonly marketId: MarketId;
  /** Вопрос рынка (для имени файла) */
  readonly question: string;
  /** Список token ID (UP/DOWN) для маршрутизации событий */
  readonly tokenIds: readonly string[];
  /** Время начала рынка (запись событий начинается с этого момента). Если не задано — записываем сразу. */
  readonly startsAt?: Timestamp;
  /** Время истечения рынка */
  readonly expiresAt: Timestamp;
  /**
   * Полные сырые данные рынка из REST API (опционально).
   * Записывается в meta-строку снапшота под ключом `"m"` для воспроизведения в бектесте.
   */
  readonly rawMarket?: Record<string, unknown>;
}

/**
 * Порт записи сырых рыночных данных.
 *
 * @remarks
 * Все методы fire-and-forget (не блокируют trading path).
 * `recordEvent` специально синхронный — минимальный overhead.
 */
export interface IMarketDataRecorder {
  /**
   * Регистрирует рынок: создаёт файл, записывает meta-событие.
   *
   * @param meta - Метаданные рынка
   *
   * @remarks
   * Идемпотентный — повторный вызов для того же marketId — no-op.
   */
  registerMarket(meta: MarketMeta): void;

  /**
   * Записывает сырое WS-событие в буфер (синхронно, fire-and-forget).
   *
   * @param tokenId - ID токена (YES или NO)
   * @param rawEvent - Сырое событие как пришло с биржи
   *
   * @remarks
   * Никогда не бросает. Если tokenId не зарегистрирован — молча пропускает.
   */
  recordEvent(tokenId: string, rawEvent: unknown): void;

  /**
   * Завершает запись рынка: сбрасывает буфер, закрывает поток, сжимает файл.
   *
   * @param marketId - ID рынка
   * @param reason - Причина завершения
   *
   * @throws При ошибке I/O (диск полон, нет прав)
   */
  finalizeMarket(marketId: MarketId, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void>;

  /**
   * Принудительно сбрасывает все буферы на диск.
   *
   * @throws При ошибке записи
   */
  flush(): Promise<void>;

  /**
   * Завершает работу: финализирует все рынки, останавливает таймеры.
   *
   * @throws При ошибке I/O
   */
  close(): Promise<void>;

  /**
   * Удаляет незавершённые файлы от предыдущих запусков.
   *
   * @remarks
   * Файлы, сохранённые в `.incomplete/` при прошлом shutdown, удаляются.
   * Вызывать при старте до регистрации рынков.
   *
   * @throws При ошибке I/O
   */
  // TODO(recovery): replace destructive cleanup() with recoverIncomplete()/
  // quarantineIncomplete()/cleanupQuarantineOlderThan(). Incomplete files may
  // be needed for crash recovery/debug.
  cleanup(): Promise<void>;

  /**
   * Проверяет, включена ли запись.
   *
   * @returns true если рекордер активен
   */
  isEnabled(): boolean;
}

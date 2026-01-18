/**
 * Replay Runner - воспроизведение событий из snapshot файлов
 *
 * @remarks
 * Читает snapshot файлы, нормализует события и воспроизводит их через callback handler.
 *
 * Ключевые особенности:
 * - Backpressure control: события обрабатываются последовательно (await)
 * - Два режима: MAX (без задержек) и SCALED (с масштабированными задержками)
 * - Graceful shutdown через AbortSignal
 * - Graceful error handling: ошибки логируются, но обработка продолжается
 * - Полная статистика воспроизведения
 *
 * Алгоритм (SCALED режим):
 * 1. Сканируем snapshot файлы
 * 2. Для каждого файла:
 *    - Читаем построчно
 *    - Нормализуем через normalizeSnapshotEvent
 *    - Если событие валидно:
 *      - Вычисляем задержку: delay = (event.ts - prev.ts) * scale
 *      - Ограничиваем: actualDelay = min(delay, maxCatchupDelay)
 *      - await sleep(actualDelay)
 *      - await eventHandler(event)
 * 3. Возвращаем статистику
 *
 * @example
 * ```typescript
 * const runner = new ReplayRunner(scanner, readerFactory, config, logger);
 *
 * const stats = await runner.run(async (event) => {
 *   if (event.eventName === 'OrderBookSnapshotReceived') {
 *     // Process orderbook
 *   } else if (event.eventName === 'TradeExecuted') {
 *     // Process trade
 *   }
 * });
 *
 * console.log(`Processed ${stats.processedEvents} events in ${stats.durationMs}ms`);
 * ```
 *
 * @module application/services/bucketizer
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { DomainEvent } from '../../../domain/events/DomainEvent.js';
import type { SnapshotScanner } from '../../../infrastructure/persistence/snapshot-readers/SnapshotScanner.js';
import type { SnapshotReaderFactory } from '../../../infrastructure/persistence/snapshot-readers/SnapshotReaderFactory.js';
import { normalizeSnapshotEvent } from './SnapshotEventNormalizer.js';
import type { ReplayConfig, ReplayStats } from './types/replay.js';

/**
 * Sleep utility для задержек в SCALED режиме
 *
 * @param ms - Миллисекунды задержки
 * @param signal - AbortSignal для cancellation
 * @returns Promise который резолвится после задержки
 *
 * @throws {Error} Если signal был aborted
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timeout = setTimeout(resolve, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error('Aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Replay Runner
 *
 * @remarks
 * Воспроизводит события из snapshot файлов с backpressure control.
 */
export class ReplayRunner {
  private readonly scanner: SnapshotScanner;
  private readonly readerFactory: SnapshotReaderFactory;
  private readonly config: ReplayConfig;
  private readonly logger: ILogger;

  /**
   * Создаёт новый ReplayRunner
   *
   * @param scanner - Сканер snapshot файлов
   * @param readerFactory - Фабрика для создания readers
   * @param config - Конфигурация replay
   * @param logger - Логгер
   */
  constructor(
    scanner: SnapshotScanner,
    readerFactory: SnapshotReaderFactory,
    config: ReplayConfig,
    logger: ILogger
  ) {
    this.scanner = scanner;
    this.readerFactory = readerFactory;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Запускает воспроизведение событий
   *
   * @param eventHandler - Callback для обработки событий
   * @param onFileComplete - Callback вызываемый после каждого файла (для финализации attempts)
   * @param signal - AbortSignal для graceful shutdown
   * @returns Статистика воспроизведения
   *
   * @throws {Error} Если воспроизведение было прервано (signal.abort())
   *
   * @remarks
   * Обрабатывает события последовательно (backpressure).
   * Ошибки в eventHandler логируются, но не останавливают воспроизведение.
   * onFileComplete вызывается после обработки всех событий из каждого файла.
   *
   * @example
   * ```typescript
   * const abortController = new AbortController();
   *
   * // Graceful shutdown
   * process.on('SIGINT', () => abortController.abort());
   *
   * try {
   *   const stats = await runner.run(
   *     async (event) => { ... },
   *     async () => { await pipeline.finalizeFile(); },
   *     abortController.signal
   *   );
   * } catch (error) {
   *   if (error.message === 'Aborted') {
   *     console.log('Replay stopped gracefully');
   *   }
   * }
   * ```
   */
  async run(
    eventHandler: (event: DomainEvent) => Promise<void>,
    onFileComplete?: () => Promise<void>,
    signal?: AbortSignal
  ): Promise<ReplayStats> {
    const startTime = new Date();

    this.logger.info('Starting replay', {
      mode: this.config.mode,
      scale: this.config.scale,
      maxCatchupDelayMs: this.config.maxCatchupDelayMs,
      scanOptions: this.config.scanOptions,
    });

    // Инициализируем статистику
    const stats: ReplayStats = {
      totalEvents: 0,
      processedEvents: 0,
      skippedEvents: 0,
      errorEvents: 0,
      filesProcessed: 0,
      startTime,
      endTime: new Date(),
      durationMs: 0,
      eventsByType: {},
      totalDelayMs: 0,
    };

    // Проверяем abort до начала
    if (signal?.aborted) {
      throw new Error('Aborted');
    }

    // Сканируем snapshot файлы
    const scanResult = await this.scanner.scan(this.config.scanOptions);

    this.logger.info('Scan complete', {
      totalFiles: scanResult.totalFiles,
      totalSizeMB: (scanResult.totalSizeBytes / (1024 * 1024)).toFixed(2),
      dateRange: scanResult.dateRange,
    });

    if (scanResult.totalFiles === 0) {
      this.logger.warn('No snapshot files found');
      stats.endTime = new Date();
      stats.durationMs = stats.endTime.getTime() - stats.startTime.getTime();
      return stats;
    }

    // Обрабатываем файлы последовательно
    let previousEventTimestamp: Date | null = null;
    const totalFiles = scanResult.files.length;
    let processedFiles = 0;

    for (const fileInfo of scanResult.files) {
      // Проверяем abort между файлами
      if (signal?.aborted) {
        throw new Error('Aborted');
      }

      processedFiles++;
      this.logger.info(`[${processedFiles}/${totalFiles}] Processing ${fileInfo.fileName}`, {
        date: fileInfo.date,
        sizeKB: (fileInfo.sizeBytes / 1024).toFixed(2),
      });

      // Создаём reader для файла
      const reader = this.readerFactory.create(fileInfo.filePath);

      try {
        // Обрабатываем события из файла
        for await (const line of reader.readLines()) {
          // Проверяем abort перед каждым событием
          if (signal?.aborted) {
            throw new Error('Aborted');
          }

          stats.totalEvents++;

          // Нормализуем событие
          const event = normalizeSnapshotEvent(line);

          if (event === null) {
            // Невалидное событие или контрольное сообщение
            stats.skippedEvents++;
            continue;
          }

          // Обновляем статистику по типам
          const eventType = (event as any).eventName || 'unknown';
          stats.eventsByType[eventType] =
            (stats.eventsByType[eventType] || 0) + 1;

          // SCALED режим: вычисляем задержку
          if (this.config.mode === 'SCALED' && previousEventTimestamp) {
            const timeDiff =
              event.timestamp.getTime() - previousEventTimestamp.getTime();

            if (timeDiff > 0) {
              const scale = this.config.scale ?? 1.0;
              const maxDelay = this.config.maxCatchupDelayMs ?? Infinity;

              const scaledDelay = timeDiff * scale;
              const actualDelay = Math.min(scaledDelay, maxDelay);

              stats.totalDelayMs += actualDelay;

              // Sleep с поддержкой abort
              await sleep(actualDelay, signal);
            }
          }

          // Обновляем previous timestamp для следующей итерации
          previousEventTimestamp = event.timestamp;

          // Обрабатываем событие через callback
          try {
            await eventHandler(event);
            stats.processedEvents++;
          } catch (error) {
            // Ошибка в callback - логируем и продолжаем
            this.logger.error('Event handler error', {
              eventType,
              assetId: (event as any).assetId,
              error,
            });
            stats.errorEvents++;
          }
        }

        stats.filesProcessed++;
      } catch (error) {
        // Ошибка при чтении/декомпрессии файла
        this.logger.error('Failed to process file, skipping', {
          file: fileInfo.fileName,
          filePath: fileInfo.filePath,
          error: error instanceof Error ? error.message : String(error),
        });

        // Продолжаем со следующим файлом
        // Не пробрасываем ошибку выше
      } finally {
        // Всегда закрываем reader (cleanup temp files)
        try {
          await reader.close();
        } catch (closeError) {
          // Ignore cleanup errors
          this.logger.warn('Failed to close reader', {
            file: fileInfo.fileName,
            error: closeError,
          });
        }

        // Финализируем файл (закрываем все активные attempts для этого файла)
        if (onFileComplete) {
          try {
            await onFileComplete();
          } catch (error) {
            this.logger.error('File finalization error', {
              file: fileInfo.fileName,
              error,
            });
          }
        }
      }
    }

    // Финализируем статистику
    stats.endTime = new Date();
    stats.durationMs = stats.endTime.getTime() - stats.startTime.getTime();

    this.logger.info('Replay complete', {
      totalEvents: stats.totalEvents,
      processedEvents: stats.processedEvents,
      skippedEvents: stats.skippedEvents,
      errorEvents: stats.errorEvents,
      filesProcessed: stats.filesProcessed,
      durationMs: stats.durationMs,
      totalDelayMs: stats.totalDelayMs,
      eventsByType: stats.eventsByType,
    });

    return stats;
  }
}

/**
 * Builder: создание инфраструктуры записи данных (DataRecorder + DecisionJournal).
 *
 * @remarks
 * Создаёт `DataRecorder` для записи сырых WS-событий и `DecisionJournalRecorder`
 * для журнала решений стратегии. Оба создаются только если `recording.enabled = true`.
 *
 * @example
 * ```typescript
 * const recording = buildRecording(config.recording, logger);
 * if (recording) {
 *   // Передать recording.dataRecorder в MarketDataFeedAdapter
 *   // Передать recording.journal в стратегии через strategyFactory
 * }
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { IMarketDataRecorder } from '@polymarket/ports';
import type { IDecisionJournal } from '@polymarket/ports';
import type { RecordingConfig } from '../config/BotConfig.js';
import {
  DataRecorder,
  NDJSONFormatter,
  GzipCompressor,
  DecisionJournalRecorder,
} from '@polymarket/data-collection';

/**
 * Результат создания инфраструктуры записи.
 *
 * @param dataRecorder - Рекордер сырых WS-событий (для MarketDataFeedAdapter)
 * @param journal - Журнал решений стратегии (для стратегий)
 */
export interface RecordingInfra {
  readonly dataRecorder: IMarketDataRecorder;
  readonly journal: IDecisionJournal;
}

/**
 * Создаёт инфраструктуру записи данных.
 *
 * @param config - Конфигурация записи (из BotConfig.recording)
 * @param logger - Логгер
 * @returns RecordingInfra или undefined если запись отключена
 */
export function buildRecording(
  config: RecordingConfig | undefined,
  logger: ILogger,
): RecordingInfra | undefined {
  if (!config?.enabled) {
    logger.info('Recording disabled');
    return undefined;
  }

  const recorderLogger = logger.child({ component: 'Recording' });

  const formatter = new NDJSONFormatter();
  const compressor = config.compression === 'gzip' ? new GzipCompressor() : null;

  const dataRecorder = new DataRecorder(
    {
      outputDir: config.outputDir,
      bufferSize: 100,
      flushIntervalMs: 10_000,
      compression: config.compression,
    },
    formatter,
    compressor,
    recorderLogger,
  );

  const journal = new DecisionJournalRecorder(
    { journalDir: config.journalDir },
    recorderLogger,
  );

  recorderLogger.warn('Recording enabled', {
    outputDir: config.outputDir,
    journalDir: config.journalDir,
    compression: config.compression,
  });

  return { dataRecorder, journal };
}

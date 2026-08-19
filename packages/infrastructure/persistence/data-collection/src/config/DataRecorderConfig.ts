/**
 * Конфигурация DataRecorder.
 */

/**
 * Параметры записи рыночных данных.
 */
export interface DataRecorderConfig {
  /**
   * Директория для записи файлов.
   * Структура: `outputDir/YYYY-MM-DD/{sourceSubDir}/{question}___{marketId}.jsonl`
   */
  readonly outputDir: string;

  /**
   * Поддиректория источника внутри date-папки.
   * Если задана: `outputDir/YYYY-MM-DD/{sourceSubDir}/filename`
   * Если не задана: `outputDir/YYYY-MM-DD/filename` (обратная совместимость)
   * @example `'polymarket'` → `data/snapshots/2026-04-06/polymarket/`
   */
  readonly sourceSubDir?: string;

  /**
   * Количество событий в буфере до принудительного сброса.
   * @defaultValue 100
   */
  readonly bufferSize: number;

  /**
   * Интервал периодического сброса буфера (мс).
   * Защита от долгих периодов тишины.
   * @defaultValue 10_000
   */
  readonly flushIntervalMs: number;

  /**
   * Режим сжатия файла при финализации.
   * - `'none'` — без сжатия, файл остаётся как `.jsonl`
   * - `'gzip'` — сжатие в `.jsonl.gz` при финализации с reason=EXPIRED
   * @defaultValue 'gzip'
   */
  readonly compression: 'none' | 'gzip';

  /**
   * Версия формата payload-строк, записываемая в first-line meta.
   *
   * Формат — свойство всего recording-пайплайна (экземпляра рекордера), а не
   * отдельного рынка: один экземпляр пишет строки только одного формата.
   * - не задана — meta без поля `formatVersion` (legacy wire-формат старого
   *   коллектора; байтовая совместимость первой строки сохраняется);
   * - `2` — строки 2+ содержат source-native события официального SDK
   *   (decoded `StandardMarketEvent`/RTDS-события), записанные V2-рекордером.
   *
   * Reader/бектест по первой строке определяет, каким парсером читать строки 2+.
   */
  readonly formatVersion?: number;
}

/** Конфигурация по умолчанию */
export const DEFAULT_RECORDER_CONFIG: DataRecorderConfig = {
  outputDir: './data/snapshots',
  bufferSize: 100,
  flushIntervalMs: 10_000,
  compression: 'gzip',
};

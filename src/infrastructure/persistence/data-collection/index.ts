/**
 * Data Collection Module
 *
 * @remarks
 * Модуль для записи raw market data с Polymarket.
 * Используется для анализа и бэктестов.
 *
 * Компоненты:
 * - DataRecorder: основной класс записи
 * - Formatters: NDJSON, Parquet, Arrow
 * - Compression: gzip
 *
 * @module infrastructure/persistence/data-collection
 */

export { DataRecorder } from './DataRecorder.js';
export type { DataRecorderConfig } from './DataRecorder.js';

export * from './formatters/index.js';
export * from './compression/index.js';

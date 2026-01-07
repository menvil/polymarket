/**
 * Data Collection Formatters
 *
 * @remarks
 * Форматтеры для сериализации market data.
 * Поддерживаемые форматы:
 * - NDJSON (JSON Lines) - основной, streaming
 * - Parquet - columnar, efficient for analysis
 * - Arrow - in-memory columnar
 *
 * @module infrastructure/persistence/data-collection/formatters
 */

export type { IFormatter, DataFormat } from './IFormatter.js';
export { NDJSONFormatter } from './NDJSONFormatter.js';
export { ParquetFormatter } from './ParquetFormatter.js';
export { ArrowFormatter } from './ArrowFormatter.js';

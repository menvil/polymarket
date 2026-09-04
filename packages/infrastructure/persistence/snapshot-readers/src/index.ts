/**
 * @polymarket/snapshot-readers — чтение архивов рыночных данных.
 *
 * @remarks
 * Читает NDJSON снапшоты записанные `@polymarket/data-collection`.
 *
 * ### Использование:
 * ```typescript
 * import {
 *   SnapshotScanner,
 *   SnapshotReaderFactory,
 * } from '@polymarket/snapshot-readers';
 *
 * const scanner = new SnapshotScanner('./data/snapshots', logger);
 * const { files } = await scanner.scan({ fromDate: '2026-01-01' });
 *
 * const factory = new SnapshotReaderFactory(logger);
 * for (const file of files) {
 *   const reader = factory.create(file.filePath);
 *   try {
 *     for await (const line of reader.readLines()) {
 *       const event = JSON.parse(line);
 *     }
 *   } finally {
 *     await reader.close();
 *   }
 * }
 * ```
 *
 * ### Replayable Raw Format V2
 *
 * Для архивов V2 (и legacy — тем же вызовом) есть canonical reader,
 * определяющий формат по header-у и отдающий наблюдения с явной
 * `timingQuality`:
 *
 * ```typescript
 * import {
 *   RawArchiveObservationReader,
 *   SnapshotReaderFactory,
 * } from '@polymarket/snapshot-readers';
 *
 * const factory = new SnapshotReaderFactory(logger);
 * const reader = new RawArchiveObservationReader(factory.create(filePath));
 * try {
 *   for await (const observation of reader.readObservations()) {
 *     // observation.payload — source-native, как в live
 *   }
 * } finally {
 *   await reader.close();
 * }
 * ```
 */

export type { ISnapshotReader } from './ISnapshotReader.js';
export type { SnapshotFileInfo } from './SnapshotFileInfo.js';
export type { ScanOptions, ScanResult } from './SnapshotScanner.js';
export { JsonlSnapshotReader } from './JsonlSnapshotReader.js';
export { GzipJsonlSnapshotReader } from './GzipJsonlSnapshotReader.js';
export { SnapshotReaderFactory } from './SnapshotReaderFactory.js';
export { SnapshotScanner } from './SnapshotScanner.js';
export { RawArchiveObservationReader } from './RawArchiveObservationReader.js';

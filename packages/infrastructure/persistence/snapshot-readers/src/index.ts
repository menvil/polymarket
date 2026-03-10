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
 */

export type { ISnapshotReader } from './ISnapshotReader.js';
export type { SnapshotFileInfo } from './SnapshotFileInfo.js';
export type { ScanOptions, ScanResult } from './SnapshotScanner.js';
export { JsonlSnapshotReader } from './JsonlSnapshotReader.js';
export { GzipJsonlSnapshotReader } from './GzipJsonlSnapshotReader.js';
export { SnapshotReaderFactory } from './SnapshotReaderFactory.js';
export { SnapshotScanner } from './SnapshotScanner.js';

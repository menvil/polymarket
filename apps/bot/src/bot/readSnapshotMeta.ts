/**
 * Утилита для чтения meta-строки из JSONL/JSONL.GZ снапшота.
 *
 * @remarks
 * Извлекает marketId, instrumentId и asset из первой meta-строки файла.
 * Используется как в single-market, так и в multi-market бэктесте.
 */

import { asInstrumentId, asMarketId, asPolymarketCtfToken } from '@polymarket/ids';
import type { InstrumentId, MarketId, AssetId } from '@polymarket/ids';
import type { ILogger } from '@polymarket/logger';
import { SnapshotReaderFactory } from '@polymarket/snapshot-readers';

/** Результат чтения meta-строки из снапшота */
export interface SnapshotMeta {
  readonly marketId: MarketId;
  readonly instrumentId: InstrumentId;
  readonly asset: AssetId;
  /** Сырой rawMarket из Gamma API (сохранён DataRecorder в поле 'm') */
  readonly rawMarket?: Record<string, unknown>;
  /** ID комплементарного токена (другой outcome того же рынка). undefined если нет. */
  readonly complementaryInstrumentId?: InstrumentId;
}

/**
 * Читает первую meta-строку из JSONL/JSONL.GZ снапшота и извлекает marketId и instrumentId.
 *
 * @param filePath - Путь к .jsonl или .jsonl.gz файлу
 * @param outcomeIndex - Индекс outcome (0 = YES, 1 = NO)
 * @returns Объект с marketId, instrumentId, asset или null если meta не найдена
 *
 * @remarks
 * Использует SnapshotReaderFactory для прозрачной поддержки сжатых файлов.
 * Временный файл (для .gz) удаляется в finally-блоке через reader.close().
 *
 * @example
 * ```typescript
 * const meta = await readSnapshotMeta('./snapshots/Bitcoin_Up.jsonl.gz', 0);
 * if (meta) {
 *   console.log(meta.marketId, meta.instrumentId);
 * }
 * ```
 */
export async function readSnapshotMeta(
  filePath: string,
  outcomeIndex: 0 | 1,
): Promise<SnapshotMeta | null> {
  // Минимальный логгер для фабрики (readSnapshotMeta вызывается до создания основного логгера)
  const noop = () => {};
  const minLogger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => minLogger } as unknown as ILogger;
  const factory = new SnapshotReaderFactory(minLogger);
  const reader = factory.create(filePath);

  try {
    for await (const line of reader.readLines()) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (raw['t'] === 'meta') {
        const marketId = asMarketId(raw['marketId'] as string);
        const tokenIds = raw['tokenIds'] as string[];
        const tokenId = tokenIds[outcomeIndex];
        if (!marketId || !tokenId) return null;
        const instrumentId = asInstrumentId(tokenId);
        const asset = asPolymarketCtfToken(tokenId);
        if (!instrumentId || !asset) return null;
        // rawMarket сохранён в поле 'm' DataRecorder'ом
        const rawMarket = raw['m'] as Record<string, unknown> | undefined;
        // Комплементарный токен (другой outcome)
        const compIndex = 1 - outcomeIndex;
        const compTokenId = tokenIds[compIndex];
        const complementaryInstrumentId = compTokenId ? (asInstrumentId(compTokenId) ?? undefined) : undefined;
        return { marketId, instrumentId, asset, rawMarket, complementaryInstrumentId };
      }
    }
    return null;
  } finally {
    await reader.close();
  }
}

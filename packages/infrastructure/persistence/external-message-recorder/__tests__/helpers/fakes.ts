/**
 * Тестовые fakes границы storage + capturing logger.
 *
 * @remarks
 * `FakeRecordingStorage` — узкая структурная реализация порта
 * `PolymarketRecordingStorage` (subset `DataRecorder`): фиксирует вызовы для
 * ассертов маршрутизации/lifecycle, НЕ трогая диск. Настоящая persistence
 * проверяется отдельными интеграционными тестами с реальным `DataRecorder`.
 */
import type { ILogger } from '@polymarket/logger';
import type { MarketId } from '@polymarket/ids';
import type { MarketMeta } from '@polymarket/ports';
import type { RecordOutcome } from '@polymarket/data-collection';
import type { PolymarketRecordingStorage } from '../../src/index.js';

/** Захваченный вызов recordMarketEvent. */
export interface RecordedWrite {
  readonly marketId: MarketId;
  readonly payload: unknown;
}

/**
 * Storage-fake: фиксирует вызовы, исход записи программируется.
 */
export class FakeRecordingStorage implements PolymarketRecordingStorage {
  /** Зарегистрированные MarketMeta в порядке вызовов. */
  public readonly registered: MarketMeta[] = [];
  /** Все вызовы recordMarketEvent (payload — та же ссылка, что передана). */
  public readonly writes: RecordedWrite[] = [];
  /** Все финализации. */
  public readonly finalized: Array<{ marketId: MarketId; reason: 'EXPIRED' | 'SHUTDOWN' }> = [];
  /** Все обновления header. */
  public readonly metaUpdates: Array<{ marketId: MarketId; raw: Record<string, unknown> }> = [];
  /** Счётчик close() для lifecycle-ассертов. */
  public closeCalls = 0;
  /** Постоянное переопределение исхода записи (default 'recorded'). */
  public outcomeOverride: RecordOutcome | undefined;
  /** Если задана — recordMarketEvent бросает (проверка защитного контура handler-а). */
  public throwOnRecord: Error | undefined;

  public registerMarket(meta: MarketMeta): void {
    this.registered.push(meta);
  }

  public recordMarketEvent(marketId: MarketId, rawEvent: unknown): RecordOutcome {
    if (this.throwOnRecord !== undefined) {
      throw this.throwOnRecord;
    }
    this.writes.push({ marketId, payload: rawEvent });
    return this.outcomeOverride ?? 'recorded';
  }

  public async updateMarketMeta(
    marketId: MarketId,
    updatedRawMarket: Record<string, unknown>,
  ): Promise<void> {
    this.metaUpdates.push({ marketId, raw: updatedRawMarket });
  }

  public async finalizeMarket(marketId: MarketId, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
    this.finalized.push({ marketId, reason });
  }

  public async flush(): Promise<void> {
    // no-op: fake не буферизует
  }

  public async cleanup(): Promise<void> {
    // no-op: fake не трогает диск
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

/** Запись лога для ассертов. */
export interface CapturedLogEntry {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly message: string;
  readonly context?: Record<string, unknown> | undefined;
}

/**
 * Логгер, накапливающий записи в память (child возвращает тот же sink).
 */
export class CapturingLogger implements ILogger {
  public readonly entries: CapturedLogEntry[] = [];

  public trace(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'trace', message, context });
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'debug', message, context });
  }

  public info(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'info', message, context });
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'warn', message, context });
  }

  public error(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'error', message, context });
  }

  public fatal(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'fatal', message, context });
  }

  public child(_bindings: Record<string, unknown>): ILogger {
    return this;
  }

  /** Записи заданного уровня. */
  public byLevel(level: CapturedLogEntry['level']): CapturedLogEntry[] {
    return this.entries.filter((entry) => entry.level === level);
  }
}

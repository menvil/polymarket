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
import type { DelayedActivationFailureCallback, RecordOutcome } from '@polymarket/data-collection';
import type { PolymarketRecordingStorage } from '../../src/index.js';

/** Захваченный вызов recordMarketEvent. */
export interface RecordedWrite {
  readonly marketId: MarketId;
  readonly payload: unknown;
}

/**
 * Storage-fake: фиксирует вызовы, исходы регистрации/записи программируются,
 * финализация может быть искусственно задержана (тест race close↔finalize).
 */
export class FakeRecordingStorage implements PolymarketRecordingStorage {
  /** Зарегистрированные MarketMeta в порядке вызовов. */
  public readonly registered: MarketMeta[] = [];
  /** Все вызовы recordMarketEvent (payload — та же ссылка, что передана). */
  public readonly writes: RecordedWrite[] = [];
  /** Все финализации (фиксируются при ЗАВЕРШЕНИИ finalizeMarket). */
  public readonly finalized: Array<{ marketId: MarketId; reason: 'EXPIRED' | 'SHUTDOWN' }> = [];
  /** Все обновления header. */
  public readonly metaUpdates: Array<{ marketId: MarketId; raw: Record<string, unknown> }> = [];
  /** Хронология lifecycle-вызовов для ассертов упорядочивания. */
  public readonly callOrder: string[] = [];
  /** Счётчик close() для lifecycle-ассертов. */
  public closeCalls = 0;
  /** Исход следующих registerMarket (default true = writer установлен). */
  public registerOutcome = true;
  /** Постоянное переопределение исхода записи (default 'recorded'). */
  public outcomeOverride: RecordOutcome | undefined;
  /** Если задана — recordMarketEvent бросает для ЛЮБОГО рынка. */
  public throwOnRecord: Error | undefined;
  /** Если задан — recordMarketEvent бросает только для этого String(marketId). */
  public throwOnRecordForMarketId: string | undefined;
  /** Если задан — finalizeMarket ждёт этот promise перед завершением. */
  public finalizeGate: Promise<void> | undefined;
  /** Hooks отложенной активации по String(marketId) — см. failDelayedActivation. */
  public readonly activationFailureHooks = new Map<string, DelayedActivationFailureCallback>();

  public registerMarket(
    meta: MarketMeta,
    onDelayedActivationFailure?: DelayedActivationFailureCallback,
  ): boolean {
    if (!this.registerOutcome) {
      return false;
    }
    this.registered.push(meta);
    if (onDelayedActivationFailure !== undefined) {
      this.activationFailureHooks.set(String(meta.marketId), onDelayedActivationFailure);
    }
    return true;
  }

  /**
   * Симулирует асинхронный отказ отложенной активации: storage освободил
   * регистрацию и уведомляет hook (как таймерная ветка реального DataRecorder).
   */
  public failDelayedActivation(marketId: MarketId): void {
    const key = String(marketId);
    const hook = this.activationFailureHooks.get(key);
    this.activationFailureHooks.delete(key);
    hook?.(marketId);
  }

  public recordMarketEvent(marketId: MarketId, rawEvent: unknown): RecordOutcome {
    if (this.throwOnRecord !== undefined) {
      throw this.throwOnRecord;
    }
    if (this.throwOnRecordForMarketId === String(marketId)) {
      throw new Error(`storage failure for ${String(marketId)}`);
    }
    this.writes.push({ marketId, payload: rawEvent });
    return this.outcomeOverride ?? 'recorded';
  }

  /** Заморозки датасетов (`String(marketId)`) в порядке вызовов. */
  public readonly sealed: string[] = [];
  /** Исход следующих sealMarket (default true = writer найден). */
  public sealOutcome = true;
  /** Исход следующих updateMarketMeta (default true = header записан). */
  public metaUpdateOutcome = true;

  public async sealMarket(marketId: MarketId): Promise<boolean> {
    this.sealed.push(String(marketId));
    this.callOrder.push(`seal:${String(marketId)}`);
    return this.sealOutcome;
  }

  public async updateMarketMeta(
    marketId: MarketId,
    updatedRawMarket: Record<string, unknown>,
  ): Promise<boolean> {
    this.metaUpdates.push({ marketId, raw: updatedRawMarket });
    return this.metaUpdateOutcome;
  }

  public async finalizeMarket(marketId: MarketId, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
    this.callOrder.push(`finalize:start:${String(marketId)}`);
    if (this.finalizeGate !== undefined) {
      await this.finalizeGate;
    }
    this.finalized.push({ marketId, reason });
    this.callOrder.push(`finalize:end:${String(marketId)}`);
  }

  public async flush(): Promise<void> {
    // no-op: fake не буферизует
  }

  /** Строки sealed-датасета для read-passthrough (`undefined` = не читается). */
  public sealedPayloadLines: readonly string[] | undefined;

  public async readSealedPayloadLines(
    marketId: MarketId,
    filter: (line: string) => boolean,
    maxMatches = 100_000,
  ): Promise<readonly string[] | undefined> {
    // Паритет с DataRecorder: невалидный потолок — программная ошибка
    if (!Number.isInteger(maxMatches) || maxMatches <= 0) {
      throw new Error(
        `readSealedPayloadLines: maxMatches must be a positive integer, got ${String(maxMatches)}`,
      );
    }
    this.callOrder.push(`read:${String(marketId)}`);
    if (this.sealedPayloadLines === undefined) {
      return undefined;
    }
    return this.sealedPayloadLines.filter(filter).slice(0, maxMatches);
  }

  public async cleanup(): Promise<void> {
    // no-op: fake не трогает диск
  }

  /** Если задана — close() отклоняется этой ошибкой (после учёта вызова). */
  public closeRejection: Error | undefined;

  public async close(): Promise<void> {
    this.closeCalls += 1;
    this.callOrder.push('storage:close');
    if (this.closeRejection !== undefined) {
      throw this.closeRejection;
    }
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

/** Захваченный вызов оконной CEX-записи. */
export interface CexRecordedWrite {
  readonly exchangeId: string;
  readonly symbol: string;
  readonly marketType: string;
  readonly stream: 'orderbook' | 'trades';
  readonly payload: unknown;
}

/**
 * Fake оконного CEX-storage: фиксирует вызовы, исходы программируются.
 *
 * @remarks
 * Узкая структурная реализация порта `CexRecordingStorage`
 * (subset `CexWindowRecorder`) — настоящая оконная persistence проверяется
 * интеграционным one-bus-one-recorder тестом с реальным движком.
 */
export class FakeCexWindowStorage {
  /** Все вызовы write (payload — та же ссылка, что передана). */
  public readonly writes: CexRecordedWrite[] = [];
  public startCalls = 0;
  public flushCalls = 0;
  public closeCalls = 0;
  /** Постоянное переопределение исхода записи (default 'recorded'). */
  public outcomeOverride: 'recorded' | 'inactive' | 'failed' | undefined;
  /** Если задана — write бросает (проверка защитного контура handler-ов). */
  public throwOnWrite: Error | undefined;

  public start(): void {
    this.startCalls++;
  }

  public write(
    exchangeId: string,
    symbol: string,
    marketType: string,
    stream: 'orderbook' | 'trades',
    payload: unknown,
  ): 'recorded' | 'inactive' | 'failed' {
    if (this.throwOnWrite !== undefined) {
      throw this.throwOnWrite;
    }
    this.writes.push({ exchangeId, symbol, marketType, stream, payload });
    return this.outcomeOverride ?? 'recorded';
  }

  public flush(): Promise<void> {
    this.flushCalls++;
    return Promise.resolve();
  }

  public close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }
}

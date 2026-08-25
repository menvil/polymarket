/**
 * Fakes границы storage для тестов raw-контура.
 *
 * @remarks
 * Узкие структурные реализации портов `ExternalMessageRecorder`: фиксируют
 * записи, не трогая диск. Настоящая persistence проверяется тестами
 * `@polymarket/data-collection` и `@polymarket/external-message-recorder`;
 * здесь нужен только факт доставки сообщения в recorder.
 */
import type { MarketId } from '@polymarket/ids';
import type { MarketMeta } from '@polymarket/ports';
import type { CexWindowRecordOutcome, RecordOutcome } from '@polymarket/data-collection';
import type {
  CexRecordingStorage,
  PolymarketRecordingStorage,
} from '@polymarket/external-message-recorder';

/** Захваченная запись в оконный storage. */
export interface CexWindowWrite {
  readonly exchangeId: string;
  readonly symbol: string;
  readonly marketType: string;
  readonly stream: string;
  readonly payload: unknown;
}

/** Fake оконного CEX-storage. */
export class FakeCexWindowStorage implements CexRecordingStorage {
  public readonly writes: CexWindowWrite[] = [];
  public startCalls = 0;
  public closeCalls = 0;

  public start(): void {
    this.startCalls++;
  }

  public write(
    exchangeId: string,
    symbol: string,
    marketType: string,
    stream: 'orderbook' | 'trades',
    payload: unknown,
  ): CexWindowRecordOutcome {
    this.writes.push({ exchangeId, symbol, marketType, stream, payload });
    return 'recorded';
  }

  public async flush(): Promise<void> {
    // Буферов нет — сброс не нужен.
  }

  public async close(): Promise<void> {
    this.closeCalls++;
  }
}

/** Захваченная запись Polymarket-сессии. */
export interface PolymarketWrite {
  readonly marketId: MarketId;
  readonly payload: unknown;
}

/** Fake storage market-сессий. */
export class FakePolymarketRecordingStorage implements PolymarketRecordingStorage {
  public readonly registered: MarketMeta[] = [];
  public readonly writes: PolymarketWrite[] = [];
  public closeCalls = 0;

  public registerMarket(meta: MarketMeta): boolean {
    this.registered.push(meta);
    return true;
  }

  public recordMarketEvent(marketId: MarketId, rawEvent: unknown): RecordOutcome {
    this.writes.push({ marketId, payload: rawEvent });
    return 'recorded';
  }

  public async sealMarket(): Promise<boolean> {
    return true;
  }

  public async updateMarketMeta(): Promise<boolean> {
    // Header в этих тестах не проверяется.
    return true;
  }

  public async readSealedPayloadLines(): Promise<readonly string[] | undefined> {
    return undefined;
  }

  public async finalizeMarket(): Promise<void> {
    // Архивация в этих тестах не проверяется.
  }

  public async flush(): Promise<void> {
    // Буферов нет.
  }

  public async cleanup(): Promise<void> {
    // Диска нет — чистить нечего.
  }

  public async close(): Promise<void> {
    this.closeCalls++;
  }
}

/**
 * SimpleBookRegistry — простая in-memory реализация IBookRegistry.
 *
 * @remarks
 * Используется в paper/backtest/live режимах (`main.ts`) и в
 * `runMultiMarketBacktest.ts`. До Этапа 10a была независимо продублирована в
 * обоих местах (+ в 2 integration-тестах) — единственная реализация с этого
 * этапа.
 *
 * Хранит `Orderbook` в `Map` по ключу `${marketId}:${tokenId}`. `Orderbook`
 * (`@polymarket/orderbook`) иммутабелен — `set()` кладёт новый экземпляр назад
 * после каждого обновления (владеет этим `BookUpdateHandler`), `get`/
 * `getOrCreate` сами никогда не мутируют существующие записи.
 */
import { Orderbook } from '@polymarket/orderbook';
import type { MarketId, InstrumentId } from '@polymarket/ids';
import type { IBookRegistry } from '@polymarket/handlers';

/**
 * Простая in-memory реализация `IBookRegistry` — см. докблок модуля выше.
 */
export class SimpleBookRegistry implements IBookRegistry {
  private readonly _books = new Map<string, Orderbook>();

  private _key(marketId: MarketId, tokenId: InstrumentId): string {
    return `${String(marketId)}:${String(tokenId)}`;
  }

  /**
   * @param marketId - ID рынка
   * @param tokenId - ID токена (outcome)
   * @returns Текущий `Orderbook` или undefined, если ещё не записан
   */
  public get(marketId: MarketId, tokenId: InstrumentId): Orderbook | undefined {
    return this._books.get(this._key(marketId, tokenId));
  }

  /**
   * @param marketId - ID рынка
   * @param tokenId - ID токена (outcome)
   * @returns Существующий `Orderbook` или новый пустой (создаётся и сохраняется, если ещё нет записи)
   */
  public getOrCreate(marketId: MarketId, tokenId: InstrumentId): Orderbook {
    const key = this._key(marketId, tokenId);
    const existing = this._books.get(key);
    if (existing) return existing;
    // См. TSDoc BookUpdateHandler про неймингный артефакт entity: `instrumentId`
    // здесь — по контракту Orderbook.empty() — несёт marketId, не tokenId.
    const empty = Orderbook.empty(marketId as unknown as InstrumentId, tokenId);
    this._books.set(key, empty);
    return empty;
  }

  /**
   * Кладёт новый (immutable) экземпляр `Orderbook` вместо предыдущего.
   *
   * @param marketId - ID рынка
   * @param tokenId - ID токена (outcome)
   * @param book - Новый снапшот стакана
   */
  public set(marketId: MarketId, tokenId: InstrumentId, book: Orderbook): void {
    this._books.set(this._key(marketId, tokenId), book);
  }

  /**
   * @param marketId - ID рынка
   * @param tokenId - ID токена (outcome)
   */
  public delete(marketId: MarketId, tokenId: InstrumentId): void {
    this._books.delete(this._key(marketId, tokenId));
  }

  /**
   * Удаляет все записи (все outcome-токены) заданного рынка.
   *
   * @param marketId - ID рынка
   */
  public deleteMarket(marketId: MarketId): void {
    const prefix = `${String(marketId)}:`;
    for (const key of [...this._books.keys()]) {
      if (key.startsWith(prefix)) this._books.delete(key);
    }
  }
}

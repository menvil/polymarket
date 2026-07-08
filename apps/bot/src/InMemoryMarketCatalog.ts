/**
 * In-memory реализация IMarketCatalog для бота.
 *
 * @remarks
 * Простой каталог на основе Map. В production используется
 * PolymarketMarketCatalog, который заполняется из REST API.
 * Для бота достаточно ручной регистрации инструментов.
 *
 * `_byMarket` — MarketId → Set<InstrumentId>, а не одиночный InstrumentInfo:
 * один market может иметь несколько outcome-токенов (бинарный рынок: YES/NO,
 * каждый со своим instrumentId, общим marketId).
 */
import type { IMarketCatalog, InstrumentInfo } from '@polymarket/ports';
import type { InstrumentId, MarketId } from '@polymarket/ids';

export class InMemoryMarketCatalog implements IMarketCatalog {
  private readonly _byInstrument = new Map<string, InstrumentInfo>();
  private readonly _byMarket = new Map<string, Set<string>>();

  /**
   * @param instrumentId - ID инструмента
   * @returns InstrumentInfo или undefined
   */
  get(instrumentId: InstrumentId): InstrumentInfo | undefined {
    return this._byInstrument.get(String(instrumentId));
  }

  /**
   * Возвращает ПЕРВЫЙ зарегистрированный инструмент рынка.
   *
   * @param marketId - ID рынка
   * @returns InstrumentInfo или undefined
   *
   * @remarks
   * Рынок может иметь несколько outcome-токенов (YES/NO) — используй
   * `getAllByMarketId()`, если нужны все.
   */
  getByMarketId(marketId: MarketId): InstrumentInfo | undefined {
    const instrumentIds = this._byMarket.get(String(marketId));
    if (!instrumentIds || instrumentIds.size === 0) return undefined;
    const [firstId] = instrumentIds;
    return this._byInstrument.get(firstId);
  }

  /**
   * Возвращает ВСЕ инструменты (outcome-токены) заданного рынка.
   *
   * @param marketId - ID рынка
   * @returns Readonly массив InstrumentInfo (пустой, если рынок неизвестен)
   */
  getAllByMarketId(marketId: MarketId): readonly InstrumentInfo[] {
    const instrumentIds = this._byMarket.get(String(marketId));
    if (!instrumentIds) return [];
    const result: InstrumentInfo[] = [];
    for (const id of instrumentIds) {
      const info = this._byInstrument.get(id);
      if (info) result.push(info);
    }
    return result;
  }

  /**
   * @returns Все зарегистрированные инструменты
   */
  getAll(): readonly InstrumentInfo[] {
    return [...this._byInstrument.values()];
  }

  /**
   * Регистрирует инструмент в каталоге.
   *
   * @param instrument - Метаданные инструмента
   */
  register(instrument: InstrumentInfo): void {
    const existing = this._byInstrument.get(String(instrument.instrumentId));
    if (existing && String(existing.marketId) !== String(instrument.marketId)) {
      const oldSet = this._byMarket.get(String(existing.marketId));
      if (oldSet) {
        oldSet.delete(String(instrument.instrumentId));
        if (oldSet.size === 0) {
          this._byMarket.delete(String(existing.marketId));
        }
      }
    }

    this._byInstrument.set(String(instrument.instrumentId), instrument);

    const marketKey = String(instrument.marketId);
    let marketSet = this._byMarket.get(marketKey);
    if (!marketSet) {
      marketSet = new Set<string>();
      this._byMarket.set(marketKey, marketSet);
    }
    marketSet.add(String(instrument.instrumentId));
  }

  /**
   * Удаляет инструмент из каталога.
   *
   * @param instrumentId - ID инструмента для удаления
   */
  remove(instrumentId: InstrumentId): void {
    const info = this._byInstrument.get(String(instrumentId));
    if (!info) return;

    this._byInstrument.delete(String(instrumentId));

    const marketSet = this._byMarket.get(String(info.marketId));
    if (marketSet) {
      marketSet.delete(String(instrumentId));
      if (marketSet.size === 0) {
        this._byMarket.delete(String(info.marketId));
      }
    }
  }

  /** Удаляет все инструменты из каталога */
  clear(): void {
    this._byInstrument.clear();
    this._byMarket.clear();
  }
}

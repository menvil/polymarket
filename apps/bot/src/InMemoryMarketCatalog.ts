/**
 * In-memory реализация IMarketCatalog для бота.
 *
 * @remarks
 * Простой каталог на основе Map. В production используется
 * PolymarketMarketCatalog, который заполняется из REST API.
 * Для бота достаточно ручной регистрации инструментов.
 */
import type { IMarketCatalog, InstrumentInfo } from '@polymarket/ports';
import type { InstrumentId, MarketId } from '@polymarket/ids';

export class InMemoryMarketCatalog implements IMarketCatalog {
  private readonly _byInstrument = new Map<string, InstrumentInfo>();
  private readonly _byMarket = new Map<string, InstrumentInfo>();

  /**
   * @param instrumentId - ID инструмента
   * @returns InstrumentInfo или undefined
   */
  get(instrumentId: InstrumentId): InstrumentInfo | undefined {
    return this._byInstrument.get(String(instrumentId));
  }

  /**
   * @param marketId - ID рынка
   * @returns InstrumentInfo или undefined
   */
  getByMarketId(marketId: MarketId): InstrumentInfo | undefined {
    return this._byMarket.get(String(marketId));
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
    this._byInstrument.set(String(instrument.instrumentId), instrument);
    this._byMarket.set(String(instrument.marketId), instrument);
  }

  /**
   * Удаляет инструмент из каталога.
   *
   * @param instrumentId - ID инструмента для удаления
   */
  remove(instrumentId: InstrumentId): void {
    const info = this._byInstrument.get(String(instrumentId));
    if (info) {
      this._byInstrument.delete(String(instrumentId));
      this._byMarket.delete(String(info.marketId));
    }
  }

  /** Удаляет все инструменты из каталога */
  clear(): void {
    this._byInstrument.clear();
    this._byMarket.clear();
  }
}

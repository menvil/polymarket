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
   * @deprecated Use getAnyInstrumentByMarketIdForMetadataOnly() for metadata-only cases
   * and getAllByMarketId() for market-wide logic.
   */
  getByMarketId(marketId: MarketId): InstrumentInfo | undefined {
    return this.getAnyInstrumentByMarketIdForMetadataOnly(marketId);
  }

  /**
   * Возвращает ЛЮБОЙ (первый зарегистрированный) инструмент рынка —
   * ТОЛЬКО для metadata-only сценариев (tickSize, minOrderSize, preview).
   *
   * @param marketId - ID рынка
   * @returns InstrumentInfo или undefined
   *
   * @remarks
   * Для market-wide логики (закрытие рынка, settlement, cancel-all,
   * поиск ордеров) используй `getAllByMarketId()` — см. doc порта.
   */
  getAnyInstrumentByMarketIdForMetadataOnly(marketId: MarketId): InstrumentInfo | undefined {
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
   * Атомарно регистрирует (или обновляет) все инструменты одного рынка.
   *
   * @param input - `{ marketId, instruments }` — все outcome-токены рынка
   * @throws {Error} Если `instruments` пуст (почти всегда bug вызывающего кода)
   * @throws {Error} Если хотя бы один instrument имеет чужой marketId —
   *   ничего не регистрируется (validate-first, затем mutate)
   *
   * @remarks
   * Upsert, не replace: существующие инструменты рынка, не вошедшие в
   * `input.instruments`, не удаляются. См. контракт порта.
   */
  registerMarket(input: {
    readonly marketId: MarketId;
    readonly instruments: readonly InstrumentInfo[];
  }): void {
    if (input.instruments.length === 0) {
      throw new Error(`registerMarket: empty instruments list for market ${String(input.marketId)}`);
    }
    // Validate-first: partial mutation исключена.
    for (const instrument of input.instruments) {
      if (String(instrument.marketId) !== String(input.marketId)) {
        throw new Error(
          `registerMarket: instrument ${String(instrument.instrumentId)} belongs to market ` +
          `${String(instrument.marketId)}, expected ${String(input.marketId)} — nothing registered`,
        );
      }
    }
    for (const instrument of input.instruments) {
      this.register(instrument);
    }
  }

  /**
   * Удаляет ВСЕ инструменты рынка из каталога.
   *
   * @param marketId - ID рынка
   *
   * @remarks
   * Неизвестный marketId — no-op (не бросает).
   */
  removeMarket(marketId: MarketId): void {
    const instrumentIds = this._byMarket.get(String(marketId));
    if (!instrumentIds) return;
    // Копия — remove() мутирует Set во время итерации.
    for (const id of [...instrumentIds]) {
      this._byInstrument.delete(id);
    }
    this._byMarket.delete(String(marketId));
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

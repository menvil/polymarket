/**
 * Store strike/resolution цен крипто-рынков (lifecycle-метаданные).
 *
 * @remarks
 * ### Назначение
 * Хранит **только** жизненный цикл рынка: strike (priceToBeat) и resolution
 * (finalPrice) — то, чего нет в {@link CryptoMarketDataStore} (он держит
 * рыночные данные: цены и стаканы). Текущие цены НЕ дублируются здесь —
 * единый источник истины для цены — `CryptoMarketDataStore`.
 *
 * Выделен из бывшего `CryptoPriceStore`, который смешивал цену и lifecycle и
 * дублировал ценовой поток. Теперь:
 * - цена → `CryptoMarketDataStore` (история + getLatest);
 * - strike/resolution → этот стор;
 * - `getResolution()` берёт fallback-цену Chainlink из `CryptoMarketDataStore`.
 *
 * ### Asset-scoped (как раньше)
 * Ключ — базовый актив (`btc`, `eth`). На один актив в каждый момент активен
 * один 5-минутный рынок (ротация по слотам), поэтому asset-scoped ключ
 * работает. Для арбитража (два рынка на актив) strike'и держит сама стратегия,
 * этот стор там не используется.
 *
 * @example
 * ```typescript
 * const resolution = new CryptoResolutionStore(cryptoMarketDataStore);
 * resolution.lockTargetPrice('btc/usd', 70_000); // priceToBeat из Gamma API
 * // ... на settlement:
 * const outcome = resolution.getResolution('btc'); // 'UP' | 'DOWN' | undefined
 * ```
 */

import type { CryptoPriceSource } from './CryptoMarketDataStore.js';

/**
 * Минимальный читатель последней цены — реализуется `CryptoMarketDataStore`.
 */
export interface LatestPriceReader {
  /** Последняя цена источника для актива/символа. */
  getLatestPrice(symbolOrAsset: string, source: CryptoPriceSource): number | undefined;
}

/**
 * Store strike/resolution крипто-рынков.
 *
 * @remarks
 * O(1) sync reads. Цены не хранит — читает Chainlink из `LatestPriceReader`.
 */
export class CryptoResolutionStore {
  /** asset → strike (priceToBeat) */
  private readonly _targets = new Map<string, number>();
  /** asset → resolution (finalPrice / последняя цена на close) */
  private readonly _resolutions = new Map<string, number>();
  /** asset'ы с заблокированным strike (авторитетный источник — Gamma API) */
  private readonly _lockedTargets = new Set<string>();
  /** asset'ы с заблокированным resolution */
  private readonly _lockedResolutions = new Set<string>();

  /**
   * @param _priceReader - Источник последней Chainlink-цены (CryptoMarketDataStore)
   */
  constructor(private readonly _priceReader: LatestPriceReader) {}

  /**
   * Устанавливает strike (open свечи / priceToBeat). No-op если strike заблокирован.
   *
   * @param symbolOrAsset - Символ или базовый актив
   * @param price - Strike цена
   */
  setTargetPrice(symbolOrAsset: string, price: number): void {
    const asset = toAsset(symbolOrAsset);
    if (this._lockedTargets.has(asset)) return;
    this._targets.set(asset, price);
  }

  /**
   * Устанавливает и блокирует strike от перезаписи (priceToBeat из Gamma API).
   *
   * @param symbolOrAsset - Символ или базовый актив
   * @param price - Strike цена
   */
  lockTargetPrice(symbolOrAsset: string, price: number): void {
    const asset = toAsset(symbolOrAsset);
    this._targets.set(asset, price);
    this._lockedTargets.add(asset);
  }

  /**
   * Устанавливает resolution (close свечи). No-op если resolution заблокирован.
   *
   * @param symbolOrAsset - Символ или базовый актив
   * @param price - Resolution цена
   */
  setResolutionPrice(symbolOrAsset: string, price: number): void {
    const asset = toAsset(symbolOrAsset);
    if (this._lockedResolutions.has(asset)) return;
    this._resolutions.set(asset, price);
  }

  /**
   * Устанавливает и блокирует resolution от перезаписи (finalPrice из Gamma API).
   *
   * @param symbolOrAsset - Символ или базовый актив
   * @param price - Resolution цена
   */
  lockResolutionPrice(symbolOrAsset: string, price: number): void {
    const asset = toAsset(symbolOrAsset);
    this._resolutions.set(asset, price);
    this._lockedResolutions.add(asset);
  }

  /** Возвращает strike актива или `undefined`. */
  getTarget(symbolOrAsset: string): number | undefined {
    return this._targets.get(toAsset(symbolOrAsset));
  }

  /** Возвращает resolution-цену актива или `undefined`. */
  getResolutionPrice(symbolOrAsset: string): number | undefined {
    return this._resolutions.get(toAsset(symbolOrAsset));
  }

  /** Есть ли strike для актива. */
  hasTarget(symbolOrAsset: string): boolean {
    return this._targets.has(toAsset(symbolOrAsset));
  }

  /**
   * Сбрасывает всё состояние актива (strike/resolution + locks) (#3).
   *
   * @param symbolOrAsset - Символ или базовый актив
   *
   * @remarks
   * Стор asset-scoped: при ротации 5-минутных рынков на один актив старый
   * strike/resolution (особенно locked) иначе протёк бы в следующий рынок.
   * Вызывать при открытии/закрытии рынка, чтобы новый рынок стартовал чисто.
   */
  resetAsset(symbolOrAsset: string): void {
    const asset = toAsset(symbolOrAsset);
    this._targets.delete(asset);
    this._resolutions.delete(asset);
    this._lockedTargets.delete(asset);
    this._lockedResolutions.delete(asset);
  }

  /**
   * Определяет исход рынка для settlement.
   *
   * @param symbolOrAsset - Символ или базовый актив
   * @returns `'UP'` если цена ≥ strike, `'DOWN'` если ниже, `undefined` если нет данных
   *
   * @remarks
   * Приоритет:
   * 1. `resolutionPrice` (finalPrice из meta или последняя цена на close) vs strike;
   * 2. fallback — последняя Chainlink-цена из `CryptoMarketDataStore` vs strike
   *    (Polymarket резолвит по Chainlink; Binance НЕ используется).
   *
   * **Контракт вызова:** fallback на последнюю Chainlink-цену корректен ТОЛЬКО на
   * момент settlement (рынок истёк — последняя цена и есть resolution). Передайте
   * `opts` с `nowMs`/`settlementTsMs` — тогда до фактического закрытия рынка
   * (`nowMs < settlementTsMs`) метод вернёт `undefined` вместо преждевременного
   * исхода по ещё живой цене (#4).
   *
   * @param opts - Опциональный settlement-guard: `{ nowMs, settlementTsMs }`
   */
  getResolution(
    symbolOrAsset: string,
    opts?: { readonly nowMs: number; readonly settlementTsMs: number },
  ): 'UP' | 'DOWN' | undefined {
    // #4: не резолвим рынок до его истечения.
    if (opts && opts.nowMs < opts.settlementTsMs) return undefined;

    const asset = toAsset(symbolOrAsset);
    const target = this._targets.get(asset);
    if (target === undefined) return undefined;

    const resolution = this._resolutions.get(asset);
    if (resolution !== undefined) return resolution >= target ? 'UP' : 'DOWN';

    const chainlink = this._priceReader.getLatestPrice(asset, 'polymarket_chainlink');
    if (chainlink !== undefined) return chainlink >= target ? 'UP' : 'DOWN';

    return undefined;
  }
}

/**
 * Нормализует символ/актив в базовый актив (lowercase): `BTC/USD`→`btc`, `BTCUSDT`→`btc`.
 */
function toAsset(symbolOrAsset: string): string {
  const normalized = symbolOrAsset.trim().toLowerCase();
  if (normalized.includes('/')) return normalized.split('/')[0] ?? '';
  if (normalized.includes('-')) return normalized.split('-')[0] ?? '';
  return normalized.replace(/usd[tc]?$/i, '');
}

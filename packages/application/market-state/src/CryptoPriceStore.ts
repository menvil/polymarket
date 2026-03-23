/**
 * In-memory store цен крипто-активов для стратегий.
 *
 * @remarks
 * ### Назначение:
 * Хранит цены от обоих источников (Chainlink + Binance) для каждого актива.
 * Стратегия получает доступ по базовому активу (`btc`, `eth`, `sol`):
 *
 * ```typescript
 * const snap = store.get('btc');
 * snap.chainlink.price  // Chainlink oracle цена (используется для resolution)
 * snap.binance.price    // Binance spot цена
 * snap.targetPrice      // Strike цена из Binance klines
 * ```
 *
 * ### Маппинг символов → актив:
 * - `btc/usd` (Chainlink) → актив `btc`, source `chainlink`
 * - `btcusdt` (Binance) → актив `btc`, source `binance`
 *
 * ### Потоки данных:
 * - `updatePrice(symbol, price, ts)` ← RTDS WebSocket или BacktestEngine
 * - `setTargetPrice(asset, price)` ← Binance klines (один раз при открытии рынка)
 * - `setResolutionPrice(asset, price)` ← Binance klines (при закрытии)
 *
 * @example
 * ```typescript
 * const store = new CryptoPriceStore();
 * store.setOnChange((asset) => {
 *   scheduler.markDirtyByAsset(asset, 'CRYPTO_PRICE');
 * });
 *
 * store.setTargetPrice('btc', 70741.27);
 * store.updatePrice('btc/usd', 70800.50, Date.now());   // chainlink
 * store.updatePrice('btcusdt', 70805.00, Date.now());    // binance
 *
 * const snap = store.get('btc');
 * // snap.chainlink?.price === 70800.50
 * // snap.binance?.price === 70805.00
 * // snap.targetPrice === 70741.27
 * ```
 */

/**
 * Цена от одного источника.
 */
export interface SourcePrice {
  readonly price: number;
  readonly timestampMs: number;
}

/**
 * Снимок цен крипто-актива (оба источника).
 *
 * @param asset - Базовый актив (e.g. 'btc', 'eth')
 * @param chainlink - Цена от Chainlink oracle (undefined если нет данных)
 * @param binance - Цена от Binance spot (undefined если нет данных)
 * @param targetPrice - Strike/open цена на eventStartTime
 * @param resolutionPrice - Финальная цена на endDate
 * @param resolved - true когда resolutionPrice установлена
 */
export interface CryptoPriceSnapshot {
  readonly asset: string;
  readonly chainlink: SourcePrice | undefined;
  readonly binance: SourcePrice | undefined;
  readonly targetPrice: number | undefined;
  readonly resolutionPrice: number | undefined;
  readonly resolved: boolean;

  // ── Удобные геттеры (обратная совместимость) ──
  /** Chainlink цена (приоритет) или Binance */
  readonly currentPrice: number;
  readonly currentPriceTimestampMs: number;
  /** @deprecated Используй asset */
  readonly symbol: string;
}

/**
 * In-memory store цен крипто-активов.
 *
 * @remarks
 * O(1) sync reads — аналогично MarketDataStore.
 * Thread-safe (single-threaded Node.js event loop).
 */
export class CryptoPriceStore {
  /** asset → { chainlink, binance } */
  private readonly _prices = new Map<string, { chainlink?: SourcePrice; binance?: SourcePrice }>();
  /** asset → target/strike price */
  private readonly _targets = new Map<string, number>();
  /** asset → resolution/close price */
  private readonly _resolutions = new Map<string, number>();
  /** asset'ы с заблокированным targetPrice (priceToBeat из Polymarket meta) */
  private readonly _lockedTargets = new Set<string>();
  /** asset'ы с заблокированным resolutionPrice (finalPrice из Polymarket meta) */
  private readonly _lockedResolutions = new Set<string>();
  /** Callback при обновлении цены */
  private _onChange?: (asset: string) => void;

  /**
   * Возвращает снимок цен для актива.
   *
   * @param symbolOrAsset - Базовый актив ('btc') или символ RTDS ('btc/usd', 'btcusdt')
   * @returns CryptoPriceSnapshot или undefined если нет данных
   */
  get(symbolOrAsset: string): CryptoPriceSnapshot | undefined {
    const asset = CryptoPriceStore._toAsset(symbolOrAsset);
    const prices = this._prices.get(asset);
    if (!prices) return undefined;

    const chainlink = prices.chainlink;
    const binance = prices.binance;
    if (!chainlink && !binance) return undefined;

    // Chainlink приоритет (Polymarket резолвит по Chainlink)
    const primary = chainlink ?? binance!;
    const resolutionPrice = this._resolutions.get(asset);

    return {
      asset,
      chainlink,
      binance,
      targetPrice: this._targets.get(asset),
      resolutionPrice,
      resolved: resolutionPrice !== undefined,
      // Обратная совместимость
      currentPrice: primary.price,
      currentPriceTimestampMs: primary.timestampMs,
      symbol: asset,
    };
  }

  /**
   * Обновляет цену актива от конкретного источника.
   *
   * @param symbol - Символ из RTDS (e.g. 'btc/usd' или 'btcusdt')
   * @param price - Цена
   * @param timestampMs - Timestamp (epoch ms)
   *
   * @remarks
   * Автоматически определяет source и asset из формата символа:
   * - `btc/usd` → asset=`btc`, source=`chainlink`
   * - `btcusdt` → asset=`btc`, source=`binance`
   */
  updatePrice(symbol: string, price: number, timestampMs: number): void {
    const { asset, source } = CryptoPriceStore._parseSymbol(symbol);

    let entry = this._prices.get(asset);
    if (!entry) { entry = {}; this._prices.set(asset, entry); }

    if (source === 'chainlink') {
      entry.chainlink = { price, timestampMs };
    } else {
      entry.binance = { price, timestampMs };
    }

    this._onChange?.(asset);
  }

  /**
   * Устанавливает target/strike цену (open свечи на eventStartTime).
   *
   * @param symbolOrAsset - Базовый актив ('btc') или символ RTDS ('btc/usd', 'btcusdt')
   * @param price - Strike цена
   *
   * @remarks
   * Не перезаписывает заблокированное значение (установленное через `lockTargetPrice`).
   */
  setTargetPrice(symbolOrAsset: string, price: number): void {
    const asset = CryptoPriceStore._toAsset(symbolOrAsset);
    if (this._lockedTargets.has(asset)) return;
    this._targets.set(asset, price);
  }

  /**
   * Устанавливает и блокирует target/strike цену от перезаписи.
   *
   * @param symbolOrAsset - Базовый актив ('btc') или символ RTDS ('btc/usd', 'btcusdt')
   * @param price - Strike цена (priceToBeat из Polymarket eventMetadata)
   *
   * @remarks
   * Используется для priceToBeat из Gamma API — авторитетный источник.
   * После вызова `setTargetPrice()` становится no-op для этого актива.
   */
  lockTargetPrice(symbolOrAsset: string, price: number): void {
    const asset = CryptoPriceStore._toAsset(symbolOrAsset);
    this._targets.set(asset, price);
    this._lockedTargets.add(asset);
  }

  /**
   * Устанавливает resolution цену (close свечи на endDate).
   *
   * @param symbolOrAsset - Базовый актив ('btc') или символ RTDS ('btc/usd', 'btcusdt')
   * @param price - Resolution цена
   *
   * @remarks
   * Не перезаписывает заблокированное значение (установленное через `lockResolutionPrice`).
   */
  setResolutionPrice(symbolOrAsset: string, price: number): void {
    const asset = CryptoPriceStore._toAsset(symbolOrAsset);
    if (this._lockedResolutions.has(asset)) return;
    this._resolutions.set(asset, price);
  }

  /**
   * Устанавливает и блокирует resolution цену от перезаписи.
   *
   * @param symbolOrAsset - Базовый актив ('btc') или символ RTDS ('btc/usd', 'btcusdt')
   * @param price - Resolution цена (finalPrice из Polymarket eventMetadata)
   *
   * @remarks
   * Используется для finalPrice из Gamma API — авторитетный источник (Chainlink oracle).
   * После вызова `setResolutionPrice()` становится no-op для этого актива.
   */
  lockResolutionPrice(symbolOrAsset: string, price: number): void {
    const asset = CryptoPriceStore._toAsset(symbolOrAsset);
    this._resolutions.set(asset, price);
    this._lockedResolutions.add(asset);
  }

  /**
   * Регистрирует callback уведомления об обновлении цены.
   *
   * @param cb - Callback: (asset) → void
   */
  setOnChange(cb: (asset: string) => void): void {
    this._onChange = cb;
  }

  /**
   * Определяет финальный исход рынка для settlement.
   *
   * @param symbolOrAsset - Базовый актив или символ RTDS
   * @returns 'UP' если цена >= targetPrice, 'DOWN' если ниже, undefined если нет данных
   *
   * @remarks
   * ### Приоритет определения исхода:
   * 1. `resolutionPrice` (finalPrice из meta или последний crypto_price) vs `targetPrice` (priceToBeat)
   * 2. Если нет resolutionPrice — последняя Chainlink цена vs targetPrice
   * 3. Без `targetPrice` (priceToBeat) — невозможно определить исход → undefined
   *
   * **Важно**: Binance цена НЕ используется для определения исхода.
   * Polymarket резолвит рынки по Chainlink oracle, поэтому только Chainlink
   * является авторитетным источником для fallback.
   */
  getResolution(symbolOrAsset: string): 'UP' | 'DOWN' | undefined {
    const asset = CryptoPriceStore._toAsset(symbolOrAsset);
    const target = this._targets.get(asset);
    if (target === undefined) return undefined;

    // Приоритет 1: resolutionPrice (finalPrice из meta или последний crypto_price)
    const resolution = this._resolutions.get(asset);
    if (resolution !== undefined) return resolution >= target ? 'UP' : 'DOWN';

    // Приоритет 2: последняя Chainlink цена (ТОЛЬКО Chainlink — Polymarket резолвит по нему)
    const prices = this._prices.get(asset);
    const chainlinkPrice = prices?.chainlink?.price;
    if (chainlinkPrice !== undefined) return chainlinkPrice >= target ? 'UP' : 'DOWN';

    // Без Chainlink цены и без resolutionPrice — исход не определён
    return undefined;
  }

  /**
   * Парсит символ RTDS в базовый актив и source.
   *
   * @param symbol - Символ из RTDS
   * @returns `{ asset, source }`
   *
   * @example
   * ```typescript
   * _parseSymbol('btc/usd')  // { asset: 'btc', source: 'chainlink' }
   * _parseSymbol('btcusdt')  // { asset: 'btc', source: 'binance' }
   * _parseSymbol('ethusdt')  // { asset: 'eth', source: 'binance' }
   * ```
   */
  /**
   * Конвертирует символ или asset в базовый asset.
   *
   * @example
   * ```typescript
   * _toAsset('btc/usd')  // 'btc'
   * _toAsset('btcusdt')  // 'btc'
   * _toAsset('btc')      // 'btc'
   * ```
   */
  static _toAsset(symbolOrAsset: string): string {
    return CryptoPriceStore._parseSymbol(symbolOrAsset).asset;
  }

  static _parseSymbol(symbol: string): { asset: string; source: 'chainlink' | 'binance' } {
    // Chainlink формат: 'btc/usd', 'eth/usd'
    if (symbol.includes('/')) {
      return { asset: symbol.split('/')[0]!, source: 'chainlink' };
    }
    // Binance формат: 'btcusdt', 'ethusdt'
    return { asset: symbol.replace(/usdt$/i, ''), source: 'binance' };
  }
}

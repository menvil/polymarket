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

import type { ILogger } from '@polymarket/logger';
import type { CryptoPriceSource, CryptoPricePoint } from './CryptoMarketDataStore.js';

/**
 * Читатель цены с timestamp — реализуется `CryptoMarketDataStore`.
 *
 * @remarks
 * Для settlement нужна не просто цена-`number`, а цена с timestamp, чтобы
 * проверить её свежесть относительно момента истечения рынка (#4).
 */
export interface LatestPriceReader {
  /** Последний ценовой тик источника (с timestamp). */
  getLatestPricePoint(symbolOrAsset: string, source: CryptoPriceSource): CryptoPricePoint | undefined;
  /** Ценовой тик источника, ближайший к `tsMs` в пределах `maxDistanceMs`. */
  getNearestPricePoint(
    symbolOrAsset: string,
    source: CryptoPriceSource,
    tsMs: number,
    maxDistanceMs: number,
  ): CryptoPricePoint | undefined;
}

/**
 * Lifecycle-состояние активного рынка по активу (#3).
 *
 * @remarks
 * Закрепляет инвариант «один активный crypto-resolution рынок на актив» в коде:
 * `startMarket()` перезаписывает состояние и предупреждает, если предыдущий
 * рынок ещё не был разрешён (потенциальный overlap — нарушение инварианта).
 */
interface ActiveMarketState {
  readonly targetPrice: number | undefined;
  readonly settlementTsMs: number | undefined;
  resolved: boolean;
}

/**
 * Дефолтный максимальный возраст Chainlink-цены относительно settlement (ms) (#4).
 *
 * @remarks
 * 10с — для 5-минутного крипто-рынка цена близко к expiry. Более щедрый лаг
 * (например, 60с для аварийного backfill) задаётся явно через `maxResolutionLagMs`.
 */
const DEFAULT_MAX_RESOLUTION_LAG_MS = 10_000;

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
  /** Lifecycle-состояние активного рынка по активу (#3). */
  private readonly _active = new Map<string, ActiveMarketState>();
  private readonly _logger: ILogger | undefined;

  /**
   * @param _priceReader - Источник Chainlink-цены с timestamp (CryptoMarketDataStore)
   * @param logger - Логгер для диагностики (опционально)
   */
  constructor(private readonly _priceReader: LatestPriceReader, logger?: ILogger) {
    this._logger = logger?.child({ component: 'CryptoResolutionStore' });
  }

  /**
   * Атомарно открывает рынок по активу (#3): сбрасывает прошлое состояние и
   * (опц.) фиксирует strike + время истечения.
   *
   * @param input - `{ symbolOrAsset, targetPrice?, settlementTsMs?, source? }`
   *
   * @remarks
   * Единственная точка входа для **основного кода** (ротация рынков). Убирает
   * footgun «забыли resetAsset»: открытие нового рынка всегда чистит старый
   * strike/resolution/locks. `setTargetPrice` оставлен только для replay/тестов.
   * Если предыдущий рынок ещё не был разрешён — пишет warn (нарушение инварианта
   * «один активный рынок на актив»).
   */
  startMarket(input: {
    readonly symbolOrAsset: string;
    readonly targetPrice?: number;
    readonly settlementTsMs?: number;
    readonly source?: 'gamma' | 'binance_kline' | 'chainlink' | 'manual';
  }): void {
    const asset = toAsset(input.symbolOrAsset);
    const prev = this._active.get(asset);
    if (prev && !prev.resolved) {
      this._logger?.warn('startMarket overwrites unresolved market (one-active-per-asset invariant)', {
        asset,
        prevSettlementTsMs: prev.settlementTsMs,
        source: input.source,
      });
    }

    this.resetAsset(asset);
    this._active.set(asset, {
      targetPrice: input.targetPrice,
      settlementTsMs: input.settlementTsMs,
      resolved: false,
    });
    if (input.targetPrice !== undefined) {
      this.lockTargetPrice(asset, input.targetPrice);
    }
  }

  /**
   * Авторитетный settlement рынка (#2): вычисляет исход, **замораживает**
   * resolution-цену и помечает рынок разрешённым.
   *
   * @param input - `{ symbolOrAsset, settlementTsMs?, maxResolutionLagMs? }`
   * @returns `'UP'` / `'DOWN'` или `undefined`, если нет strike/свежей цены
   *
   * @remarks
   * В отличие от read-only {@link getResolution}, это **переход состояния**
   * `unresolved → resolved` с фиксацией цены — поэтому идемпотентен: повторный
   * вызов вернёт уже замороженный исход, а не пере-резолвит по более позднему тику.
   * Единая точка фактического закрытия рынка в live и backtest.
   *
   * Алгоритм:
   * 1. Нет strike → `undefined`.
   * 2. Есть зафиксированная `resolutionPrice` → помечаем resolved, возвращаем по ней.
   * 3. Иначе — ближайшая свежая Chainlink-цена около `settlementTsMs`
   *    (в пределах `maxResolutionLagMs`); если нет — warn + `undefined`
   *    (НЕ резолвим по устаревшей цене). Иначе фиксируем и помечаем resolved.
   */
  settleMarket(input: {
    readonly symbolOrAsset: string;
    readonly settlementTsMs?: number;
    readonly maxResolutionLagMs?: number;
  }): 'UP' | 'DOWN' | undefined {
    const asset = toAsset(input.symbolOrAsset);
    const target = this._targets.get(asset);
    if (target === undefined) return undefined;

    const markResolved = (): void => {
      const state = this._active.get(asset);
      if (state) state.resolved = true;
    };

    // (2) уже зафиксированная resolutionPrice — авторитетна.
    const existing = this._resolutions.get(asset);
    if (existing !== undefined) {
      markResolved();
      return existing >= target ? 'UP' : 'DOWN';
    }

    // (3) Chainlink-fallback — СТРОГО требует settlementTsMs. В отличие от read-only
    // getResolution, authoritative settleMarket не замораживает «просто последнюю
    // цену» без привязки к expiry (#1).
    const settlementTsMs = input.settlementTsMs ?? this._active.get(asset)?.settlementTsMs;
    if (settlementTsMs === undefined) {
      this._logger?.warn('settleMarket skipped: settlementTsMs required for Chainlink fallback', { asset });
      return undefined;
    }

    const maxLag = input.maxResolutionLagMs ?? DEFAULT_MAX_RESOLUTION_LAG_MS;
    const point = this._priceReader.getNearestPricePoint(asset, 'polymarket_chainlink', settlementTsMs, maxLag);
    if (point === undefined) {
      this._logger?.warn('settleMarket skipped: no fresh Chainlink price', {
        asset,
        settlementTsMs,
        maxResolutionLagMs: maxLag,
      });
      return undefined;
    }

    this.lockResolutionPrice(asset, point.price); // заморозка → идемпотентность
    markResolved();
    return point.price >= target ? 'UP' : 'DOWN';
  }

  /**
   * Устанавливает strike (open свечи / priceToBeat). No-op если strike заблокирован.
   *
   * @param symbolOrAsset - Символ или базовый актив
   * @param price - Strike цена
   *
   * @remarks
   * Низкоуровневый метод — для replay (BacktestEngine) и тестов. В основном
   * коде ротации используйте {@link startMarket}.
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
    this._active.delete(asset);
  }

  /**
   * **Read-only** (non-authoritative) определение исхода — для UI/диагностики (#U3).
   *
   * @param symbolOrAsset - Символ или базовый актив
   * @returns `'UP'` если цена ≥ strike, `'DOWN'` если ниже, `undefined` если нет данных
   *
   * @remarks
   * Это НЕ settlement-action: ничего не замораживает и не помечает `resolved`.
   * Авторитетное закрытие рынка — {@link settleMarket}. Если передан `nowMs`
   * (намёк на settlement-интент), но `settlementTsMs` неизвестен — метод вернёт
   * `undefined` (нельзя проверить ни истечение, ни свежесть). Мягкий latest-fallback
   * сохранён только для read-only/replay-чтения без `nowMs`.
   *
   * Приоритет:
   * 1. `resolutionPrice` (finalPrice из meta или последняя цена на close) vs strike;
   * 2. fallback — последняя Chainlink-цена из `CryptoMarketDataStore` vs strike
   *    (Polymarket резолвит по Chainlink; Binance НЕ используется).
   *
   * **Контракт вызова:** fallback на последнюю Chainlink-цену корректен ТОЛЬКО на
   * момент settlement (рынок истёк — последняя цена и есть resolution).
   *
   * **Guard'ы (#4):**
   * - `nowMs < settlementTsMs` → `undefined` (рынок ещё не истёк);
   * - Chainlink-fallback требует **свежую** цену около `settlementTsMs`
   *   (через `getNearestPricePoint`, не далее `maxResolutionLagMs`) — иначе
   *   `undefined` + warn, чтобы не зарезолвить рынок устаревшей ценой.
   *
   * `settlementTsMs` берётся из `opts` или из lifecycle-state (`startMarket`).
   *
   * @param opts - Опциональный settlement-guard:
   *   `{ nowMs?, settlementTsMs?, maxResolutionLagMs? }`
   */
  getResolution(
    symbolOrAsset: string,
    opts?: {
      readonly nowMs?: number;
      readonly settlementTsMs?: number;
      readonly maxResolutionLagMs?: number;
    },
  ): 'UP' | 'DOWN' | undefined {
    const asset = toAsset(symbolOrAsset);
    const target = this._targets.get(asset);
    if (target === undefined) return undefined;

    const settlementTsMs = opts?.settlementTsMs ?? this._active.get(asset)?.settlementTsMs;

    // #U3: nowMs задан (settlement-интент), но settlementTsMs неизвестен → не можем
    // проверить ни истечение, ни свежесть. Не выдаём исход. (Read-only вызовы без
    // nowMs сохраняют мягкий latest-fallback.)
    if (opts?.nowMs !== undefined && settlementTsMs === undefined) return undefined;

    // #4: не резолвим рынок до его истечения.
    if (opts?.nowMs !== undefined && settlementTsMs !== undefined && opts.nowMs < settlementTsMs) {
      return undefined;
    }

    // Приоритет: явная resolutionPrice (finalPrice/close) — авторитетна, без freshness.
    const resolution = this._resolutions.get(asset);
    if (resolution !== undefined) return resolution >= target ? 'UP' : 'DOWN';

    // Fallback на Chainlink: со settlementTsMs — ближайшая свежая цена около expiry;
    // без него (legacy/replay) — последняя цена.
    const maxLag = opts?.maxResolutionLagMs ?? DEFAULT_MAX_RESOLUTION_LAG_MS;
    const point = settlementTsMs !== undefined
      ? this._priceReader.getNearestPricePoint(asset, 'polymarket_chainlink', settlementTsMs, maxLag)
      : this._priceReader.getLatestPricePoint(asset, 'polymarket_chainlink');

    if (point === undefined) {
      this._logger?.warn('No fresh Chainlink price for settlement', {
        asset,
        settlementTsMs,
        maxResolutionLagMs: maxLag,
      });
      return undefined;
    }

    return point.price >= target ? 'UP' : 'DOWN';
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

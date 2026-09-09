/**
 * Ряды референсных цен, разделённые по полной идентичности фида.
 *
 * @remarks
 * Идентичность ряда — это ВСЁ, чем canonical-событие отличает один фид от
 * другого:
 *
 * ```text
 * sourceId → baseAsset → quoteAsset → SPOT | TWAP(windowSeconds)
 * ```
 *
 * Склеивать нельзя ничего из этого: `BTC/USD` и `BTC/USDT` — разные пары,
 * Chainlink SPOT и Chainlink TWAP 30 — разные величины, а два источника с
 * одинаковой парой могут расходиться, и именно расхождение бывает сигналом.
 *
 * Вложенные типизированные Map вместо составных строк вроде
 * `"chainlink:BTC:USD:TWAP:30"`: строка теряет типы, допускает опечатку без
 * ошибки компиляции и делает невозможным обход по уровням.
 *
 * `nativeSymbol` вендора в идентичность НЕ входит — это происхождение, а не
 * различие: один и тот же фид может называться по-разному у разных
 * источников.
 */
import { RollingWindow, type RetentionPolicy } from '@polymarket/rolling-window';
import type { IClock } from '@polymarket/time';
import type { AssetSymbolId, MarketDataSourceId } from '@polymarket/ids';
import { Ok, type Result, isErr } from '@polymarket/result';
import type { ValidationError } from '@polymarket/errors';
import type { ReferencePriceObservation, ReferencePriceSeriesKey } from './observations.js';
import { observedAtMs } from './instrumentState.js';
import type { RollingWindowView } from './views.js';

/** Ряды одной пары активов у одного источника. */
interface PairSeries {
  /** Спотовый ряд, если наблюдения были */
  spot?: RollingWindow<ReferencePriceObservation>;
  /** Ряды TWAP по длине окна усреднения */
  readonly twapByWindowSeconds: Map<number, RollingWindow<ReferencePriceObservation>>;
}

/**
 * Хранилище рядов референсных цен.
 *
 * @remarks
 * Владеет деревом идентичности и создаёт листья лениво — при первом
 * наблюдении фида.
 */
export class ReferencePriceState {
  private readonly _bySource = new Map<
    MarketDataSourceId,
    Map<AssetSymbolId, Map<AssetSymbolId, PairSeries>>
  >();

  /**
   * @param _policy - Политика хранения рядов референсных цен
   * @param _clock - Часы
   */
  constructor(
    private readonly _policy: RetentionPolicy,
    private readonly _clock: IClock,
  ) {}

  /**
   * Добавляет наблюдение в ряд соответствующего фида.
   *
   * @param key - Полная идентичность фида
   * @param observation - Значение с временами площадки и наблюдения
   * @returns `Ok` после добавления либо ошибка валидации политики хранения
   *
   * @remarks
   * Ряд создаётся при первом наблюдении. Ошибка возможна только при
   * создании — политика уже проверена при создании состояния, поэтому на
   * практике этот путь недостижим, но глотать его нельзя.
   *
   * @example
   * ```typescript
   * state.append(
   *   { sourceId, baseAsset, quoteAsset, kind: 'TWAP', windowSeconds: 30 },
   *   observation,
   * );
   * ```
   */
  public append(
    key: ReferencePriceSeriesKey,
    observation: ReferencePriceObservation,
  ): Result<void, ValidationError> {
    const pair = this._pairSeries(key);
    if (key.kind === 'SPOT') {
      if (pair.spot === undefined) {
        const created = this._createWindow();
        if (isErr(created)) return created;
        pair.spot = created.value;
      }
      pair.spot.append(observation);
      return Ok(undefined);
    }

    const windowSeconds = key.windowSeconds ?? 0;
    let series = pair.twapByWindowSeconds.get(windowSeconds);
    if (series === undefined) {
      const created = this._createWindow();
      if (isErr(created)) return created;
      series = created.value;
      pair.twapByWindowSeconds.set(windowSeconds, series);
    }
    series.append(observation);
    return Ok(undefined);
  }

  /**
   * Возвращает ряд по идентичности фида.
   *
   * @param key - Полная идентичность фида
   * @returns Ряд только для чтения либо `undefined`, если наблюдений не было
   */
  public getSeries(
    key: ReferencePriceSeriesKey,
  ): RollingWindowView<ReferencePriceObservation> | undefined {
    const pair = this._bySource
      .get(key.sourceId)
      ?.get(key.baseAsset as AssetSymbolId)
      ?.get(key.quoteAsset as AssetSymbolId);
    if (pair === undefined) return undefined;
    return key.kind === 'SPOT'
      ? pair.spot
      : pair.twapByWindowSeconds.get(key.windowSeconds ?? 0);
  }

  /**
   * Перечисляет идентичности всех существующих рядов.
   *
   * @returns Ключи рядов в порядке появления источников
   */
  public seriesKeys(): readonly ReferencePriceSeriesKey[] {
    const keys: ReferencePriceSeriesKey[] = [];
    for (const [sourceId, byBase] of this._bySource) {
      for (const [baseAsset, byQuote] of byBase) {
        for (const [quoteAsset, pair] of byQuote) {
          if (pair.spot !== undefined) {
            keys.push({ sourceId, baseAsset, quoteAsset, kind: 'SPOT' });
          }
          for (const windowSeconds of pair.twapByWindowSeconds.keys()) {
            keys.push({ sourceId, baseAsset, quoteAsset, kind: 'TWAP', windowSeconds });
          }
        }
      }
    }
    return keys;
  }

  /**
   * Источники, по которым есть наблюдения.
   *
   * @returns Идентичности источников
   */
  public sourceIds(): readonly MarketDataSourceId[] {
    return [...this._bySource.keys()];
  }

  /**
   * Находит или создаёт узел пары активов.
   *
   * @param key - Идентичность фида
   * @returns Узел с рядами пары
   */
  private _pairSeries(key: ReferencePriceSeriesKey): PairSeries {
    let byBase = this._bySource.get(key.sourceId);
    if (byBase === undefined) {
      byBase = new Map();
      this._bySource.set(key.sourceId, byBase);
    }
    const base = key.baseAsset as AssetSymbolId;
    let byQuote = byBase.get(base);
    if (byQuote === undefined) {
      byQuote = new Map();
      byBase.set(base, byQuote);
    }
    const quote = key.quoteAsset as AssetSymbolId;
    let pair = byQuote.get(quote);
    if (pair === undefined) {
      pair = { twapByWindowSeconds: new Map() };
      byQuote.set(quote, pair);
    }
    return pair;
  }

  /**
   * Создаёт ряд с настроенной политикой хранения.
   *
   * @returns Ряд либо ошибка валидации политики
   */
  private _createWindow(): Result<RollingWindow<ReferencePriceObservation>, ValidationError> {
    return RollingWindow.create<ReferencePriceObservation>(
      this._policy,
      this._clock,
      observedAtMs,
    );
  }
}

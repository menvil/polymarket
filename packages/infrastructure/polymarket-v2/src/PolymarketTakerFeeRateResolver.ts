/**
 * Ставка taker-комиссии рынка — источник `Fill.fee` для REST-сделок.
 *
 * @remarks
 * ### Почему не `ClobTrade.feeRateBps`
 *
 * В записи сделки аутентифицированного REST `feeRateBps` приходит `"0"` —
 * поле не заполняется (см. `polymarket-fee.ts` в `@polymarket/fill` и
 * `apps/pnl` `TradesFetcher`). Решать по нему, была ли комиссия, значит
 * получить нулевую комиссию у тейкерской сделки, за которую площадка
 * комиссию взяла. А `fee` входит в факт исполнения (`findFillFactDifference`):
 * одна и та же сделка из WS и из REST с разной комиссией — это конфликт
 * неизменяемого факта, а не «уточнение».
 *
 * Поэтому ставку для REST-сделки даёт этот порт — по рынку сделки, — а
 * `FillMapper` считает по ней комиссию тейкера
 * (`calculatePolymarketTakerFeeWithRate`). Мейкер комиссию не платит, и для
 * MAKER-сделок порт не вызывается.
 *
 * ### Откуда ставка
 *
 * Из метаданных рынка, которые знает composition root: для семейства
 * `CRYPTO_UP_DOWN` — `POLYMARKET_CRYPTO_TAKER_FEE_RATE` (`@polymarket/fill`).
 * Рынок, ставка которого неизвестна, — отказ, а не нулевая ставка.
 */
import type { MarketId } from '@polymarket/ids';
import { Err, Ok, type Result } from '@polymarket/result';
import { PolymarketAccountStateError } from './polymarketAccountMapping.js';

/**
 * Ставка taker-комиссии по рынку.
 *
 * @remarks
 * Синхронный: ставка — знание о рынке, а не запрос к площадке. Неизвестный
 * рынок — `Err`; адаптер состояния превращает его в отказ всего прохода.
 *
 * @example
 * ```typescript
 * const rate = resolver.getTakerFeeRate(marketId); // Ok(0.07)
 * ```
 */
export interface PolymarketTakerFeeRateResolver {
  /**
   * Ставка taker-комиссии рынка.
   *
   * @param marketId - Condition id рынка сделки
   * @returns Доля (например `0.07`) либо отказ
   */
  getTakerFeeRate(marketId: MarketId): Result<number, PolymarketAccountStateError>;
}

/**
 * Ставки из заранее известного набора рынков.
 *
 * @remarks
 * Composition root собирает набор из тех же рынков, что попадают в scope
 * сверки. Ключ — condition id без учёта регистра. Ставка обязана быть
 * конечной и неотрицательной; рынок вне набора — отказ.
 *
 * @example
 * ```typescript
 * const rates = PolymarketStaticTakerFeeRateResolver.create([
 *   [marketId, POLYMARKET_CRYPTO_TAKER_FEE_RATE],
 * ]);
 * ```
 */
export class PolymarketStaticTakerFeeRateResolver implements PolymarketTakerFeeRateResolver {
  /**
   * @param _rates - Ставки по condition id в нижнем регистре
   */
  private constructor(private readonly _rates: ReadonlyMap<string, number>) {}

  /**
   * Создаёт резолвер из пар «рынок → ставка».
   *
   * @param rates - Пары `[marketId, rate]`
   * @returns Резолвер либо отказ (невалидная ставка, повтор рынка)
   *
   * @example
   * ```typescript
   * const rates = PolymarketStaticTakerFeeRateResolver.create([[market, 0.07]]);
   * ```
   */
  public static create(
    rates: Iterable<readonly [MarketId, number]>,
  ): Result<PolymarketStaticTakerFeeRateResolver, PolymarketAccountStateError> {
    const byMarket = new Map<string, number>();
    for (const [marketId, rate] of rates) {
      const key = String(marketId).toLowerCase();
      if (!Number.isFinite(rate) || rate < 0) {
        return Err(new PolymarketAccountStateError(`taker fee rate for market ${marketId} must be finite and non-negative`));
      }
      if (byMarket.has(key)) {
        return Err(new PolymarketAccountStateError(`taker fee rate for market ${marketId} is defined twice`));
      }
      byMarket.set(key, rate);
    }
    return Ok(new PolymarketStaticTakerFeeRateResolver(byMarket));
  }

  /** {@inheritDoc PolymarketTakerFeeRateResolver.getTakerFeeRate} */
  public getTakerFeeRate(marketId: MarketId): Result<number, PolymarketAccountStateError> {
    const rate = this._rates.get(String(marketId).toLowerCase());
    if (rate === undefined) {
      return Err(new PolymarketAccountStateError(`taker fee rate is unknown for market ${marketId}`));
    }
    return Ok(rate);
  }
}

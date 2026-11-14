/**
 * Ставка taker-комиссии рынка — реализация общего порта
 * `PolymarketTakerFeeRateResolver` (`@polymarket/fill`).
 *
 * @remarks
 * ### Почему не `feeRateBps` / `fee_rate_bps`
 *
 * В записи сделки аутентифицированного REST `feeRateBps` приходит `"0"` —
 * поле не заполняется (см. `polymarket-fee.ts` в `@polymarket/fill` и
 * `apps/pnl` `TradesFetcher`), а `fee_rate_bps` приватного WS заполнен
 * случайно. Решать по ним, была ли комиссия, значит получить разную комиссию
 * у одного исполнения. А `fee` входит в факт исполнения
 * (`findFillFactDifference`): одна и та же сделка из WS и из REST с разной
 * комиссией — это конфликт неизменяемого факта, а не «уточнение».
 *
 * Поэтому ставку для TAKER-исполнения даёт порт — по рынку исполнения, — а
 * `FillMapper` считает по ней комиссию тейкера
 * (`calculatePolymarketTakerFeeWithRate`). Мейкер комиссию не платит, и для
 * MAKER-исполнений порт не вызывается.
 *
 * ### Один контракт, одна декларация
 *
 * Интерфейс объявлен в `@polymarket/fill`: его же получает приватный
 * WS-обработчик (`FillEventHandler` в Application), которому импорт
 * Infrastructure запрещён. Здесь — только реализация; точка входа
 * `@polymarket/polymarket-v2/account` re-экспортирует тип для composition
 * root.
 *
 * ### Откуда ставка
 *
 * Из метаданных рынка, которые знает composition root: для семейства
 * `CRYPTO_UP_DOWN` — `POLYMARKET_CRYPTO_TAKER_FEE_RATE` (`@polymarket/fill`).
 * Рынок, ставка которого неизвестна, — отказ, а не нулевая ставка.
 */
import type { PolymarketTakerFeeRateResolver } from '@polymarket/fill';
import type { MarketId } from '@polymarket/ids';
import { Err, Ok, type Result } from '@polymarket/result';
import { PolymarketAccountStateError } from './polymarketAccountMapping.js';

/**
 * Ставки из заранее известного набора рынков.
 *
 * @remarks
 * Composition root собирает набор из тех же рынков, что попадают в scope
 * сверки. Ключ — condition id без учёта регистра. Ставка обязана быть
 * конечной и неотрицательной; рынок вне набора — отказ.
 *
 * Один и тот же экземпляр composition root передаёт обоим production-путям
 * исполнения — `FillEventHandler` (приватный WS) и
 * `PolymarketAccountVenueStateSource` (REST): тогда TAKER-исполнение
 * получает одну комиссию, каким бы путём оно ни пришло.
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

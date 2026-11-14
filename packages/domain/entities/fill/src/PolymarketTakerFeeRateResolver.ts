/**
 * Порт ставки taker-комиссии рынка Polymarket — ОДИН контракт для приватного
 * WS и REST.
 *
 * @remarks
 * ### Почему порт, а не поле сообщения
 *
 * Комиссия входит в неизменяемый факт исполнения (`findFillFactDifference`).
 * Одно исполнение, пришедшее приватным WS и REST-ом, обязано получить ОДНУ
 * комиссию. Ни одно поле vendor-сообщения для этого не годится:
 *
 * ```text
 * REST ClobTrade.feeRateBps     приходит "0" — поле не заполняется
 * WS   fee_rate_bps             заполнен случайно; по "> 0" угадывалась ставка
 * ```
 *
 * Ставка — знание о РЫНКЕ (политика комиссии семейства рынков), а не о
 * сообщении. Поэтому оба пути спрашивают её у этого порта по condition id
 * исполнения и передают в `FillMapper` (`takerFeeRate`).
 *
 * ### Почему здесь, в `@polymarket/fill`
 *
 * Приватный WS-обработчик (`FillEventHandler`) живёт в Application и не
 * может импортировать Infrastructure. Порт лежит рядом с `FillMapper` и
 * `polymarket-fee`, которые уже знают формулу комиссии Polymarket; реализации
 * (например `PolymarketStaticTakerFeeRateResolver`) живут в
 * `@polymarket/polymarket-v2`.
 *
 * ```text
 * @polymarket/fill            PolymarketTakerFeeRateResolver (интерфейс)
 *   ↑ import type                     ↑ implements
 * @polymarket/handlers        @polymarket/polymarket-v2
 * FillEventHandler (WS)      PolymarketStaticTakerFeeRateResolver,
 *                            PolymarketAccountVenueStateSource (REST)
 * ```
 */
import type { MarketId } from '@polymarket/ids';
import type { Result } from '@polymarket/result';

/**
 * Ставка taker-комиссии по рынку исполнения.
 *
 * @remarks
 * Семантика фиксирована:
 *
 * ```text
 * marketId (condition id исполнения) → ставка ДОЛЕЙ (0.07), не в bps
 * неизвестный рынок                  → Err, а не ставка по умолчанию
 * ```
 *
 * Синхронный: ставка — знание о рынке, а не запрос к площадке. Вызывается
 * только для TAKER-исполнений: мейкер комиссию не платит. Ошибку потребитель
 * превращает в отказ разбора исполнения — исполнение без известной комиссии
 * не публикуется и не попадает в authoritative-состояние.
 *
 * Тип ошибки — базовый `Error`: реализации отдают свои подтипы
 * (`Result` ковариантен по ошибке), потребителю нужен только текст.
 *
 * @example
 * ```typescript
 * const rate = takerFeeRates.getTakerFeeRate(marketId);
 * if (!rate.ok) return Err(rate.error);
 * FillMapper.allFromPolymarketTradeEvent(raw, accountId, { takerFeeRate: rate.value });
 * ```
 */
export interface PolymarketTakerFeeRateResolver {
  /**
   * Ставка taker-комиссии рынка.
   *
   * @param marketId - Condition id рынка исполнения (поле `market` сделки)
   * @returns Доля (например `0.07`) либо отказ, если ставка рынка неизвестна
   * @throws Не бросает: отказ возвращается как `Err`
   *
   * @example
   * ```typescript
   * const rate = resolver.getTakerFeeRate(marketId); // Ok(0.07)
   * ```
   */
  getTakerFeeRate(marketId: MarketId): Result<number, Error>;
}

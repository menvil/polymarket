/**
 * Торговый рантайм принял рынок к работе.
 *
 * @remarks
 * Это первое событие НАШЕГО жизненного цикла рынка и единственный способ
 * создать market-specific состояние в `TradingHotState`. До admission рынок
 * для торгового рантайма не существует, даже если его стакан уже идёт по
 * шине для коллектора или другого владельца.
 *
 * ### Почему payload несёт canonical `Market`, а не DTO
 *
 * `@polymarket/market` уже является границей «инфраструктура → приложение»:
 * `Market` immutable, провалидирован при создании и содержит ровно ту
 * структуру, которая нужна торговле (расписание, два исхода с
 * `InstrumentId`, семейство и его спецификацию). Заводить рядом
 * `TradingMarketDto` значило бы получить второе каноническое представление
 * одного рынка и обязанность их синхронизировать.
 *
 * ### Почему нет `admittedAt` в payload
 *
 * Момент перехода — это `event.metadata.createdAt`, обязательное поле
 * canonical envelope (M-003). Второе поле с тем же смыслом рано или поздно
 * разойдётся с первым.
 *
 * ### Отличие от `MARKET_OPENED`
 *
 * `MARKET_OPENED` принадлежит старому рантайму: аллокация баланса,
 * `strategyId`, запуск стратегии. Это НЕ жизненный цикл рынка, и
 * переиспользовать его значило бы построить новый lifecycle на чужих
 * гарантиях.
 *
 * @example
 * ```typescript
 * const event = {
 *   type: 'TRADING_MARKET_ADMITTED',
 *   payload: { market },
 *   metadata: metadataGenerator.nextRoot(),
 * } satisfies TradingMarketAdmittedEvent;
 * ```
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { Market } from '@polymarket/market';

export type TradingMarketAdmittedEvent = MessageEnvelope<
  'TRADING_MARKET_ADMITTED',
  {
    /**
     * Canonical рынок, принимаемый к торговле.
     *
     * @remarks
     * Ожидается внешне активный (`market.isActive()`) и ещё не начавшийся
     * рынок: `metadata.createdAt < market.startsAt`. Проверку выполняет
     * потребитель — контракт события описывает форму, а не инварианты
     * состояния.
     */
    readonly market: Market;
  }
>;

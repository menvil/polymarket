/**
 * Торговый рантайм принял торговый аккаунт к работе.
 *
 * @remarks
 * Это первое событие приватного контура и ЕДИНСТВЕННЫЙ способ создать
 * состояние аккаунта в `AccountHotState`. До инициализации аккаунт для
 * рантайма не существует, и любое `TRADING_ACCOUNT_ORDER_COMMITTED` или
 * `TRADING_ACCOUNT_FILL_APPLIED` по нему отвергается.
 *
 * ### Почему payload несёт canonical `Portfolio`, а не balance/positions
 *
 * `Portfolio` уже является единственным источником истины по деньгам,
 * позициям и токенным балансам: `balance`, `positions`, `tokenBalances`
 * живут внутри него и связаны его же инвариантами. Разложить их на три поля
 * payload значило бы завести второй источник истины и обязанность держать
 * его согласованным с первым.
 *
 * ### Почему venue отдельным полем при наличии `AccountId`
 *
 * `AccountId` бывает трёх видов, и venue содержит только `VENUE` (а также
 * `SUBACCOUNT`, чей корень — `VENUE`). У `WALLET` embedded venue нет вовсе:
 * один и тот же кошелёк торгует на нескольких площадках. Поэтому venue
 * namespace задаёт payload, а embedded venue — если он есть — обязан с ним
 * совпасть; проверку выполняет потребитель.
 *
 * ### Почему нет `initializedAt` в payload
 *
 * Момент перехода — это `event.metadata.createdAt`, обязательное поле
 * canonical envelope (M-003). Второе поле с тем же смыслом рано или поздно
 * разойдётся с первым.
 *
 * ### Producer
 *
 * Пока нет. Событие будет создаваться после authoritative startup
 * bootstrap/reconciliation — это следующий MR приватного контура.
 *
 * @example
 * ```typescript
 * const event = {
 *   type: 'TRADING_ACCOUNT_INITIALIZED',
 *   payload: { venueId, accountId, portfolio },
 *   metadata: metadataGenerator.nextRoot(),
 * } satisfies TradingAccountInitializedEvent;
 * ```
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { AccountId, VenueId } from '@polymarket/ids';
import type { Portfolio } from '@polymarket/portfolio';

export type TradingAccountInitializedEvent = MessageEnvelope<
  'TRADING_ACCOUNT_INITIALIZED',
  {
    /**
     * Площадка, в пространстве имён которой живёт аккаунт.
     *
     * @remarks
     * Владелец venue namespace. Один и тот же строковый идентификатор
     * аккаунта на двух площадках — два РАЗНЫХ торговых аккаунта.
     */
    readonly venueId: VenueId;
    /** Аккаунт, состояние которого начинает вести рантайм */
    readonly accountId: AccountId;
    /**
     * Итоговый портфель на момент принятия аккаунта.
     *
     * @remarks
     * `portfolio.accountId` и `portfolio.balance.accountId()`/`venueId()`
     * обязаны соответствовать паре из payload — иначе состояние аккаунта
     * сразу начиналось бы с чужих денег.
     */
    readonly portfolio: Portfolio;
  }
>;

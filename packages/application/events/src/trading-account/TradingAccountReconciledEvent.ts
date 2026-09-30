/**
 * Authoritative-сверка аккаунта предлагает коррекцию локального состояния.
 *
 * @remarks
 * Это НЕ live-обработка и не её замена. Живой контур (`ORDER_COMMITTED`,
 * `FILL_APPLIED`, …) описывает операции, которые рантайм выполнил сам. Сверка
 * описывает, что по этому аккаунту говорит authoritative-источник, и
 * исправляет локальное состояние там, где оно разошлось.
 *
 * ```text
 * authoritative account source
 *         ↓
 * AccountReconciler
 *         ↓
 * TRADING_ACCOUNT_RECONCILED        ← это событие
 *         ↓
 * IEventBus
 *         ↓
 * AccountStateProjector → AccountHotState
 * ```
 *
 * Отдельной шины сверки нет: коррекция идёт по ТОЙ ЖЕ canonical-шине, и
 * `AccountStateProjector` остаётся единственным писателем состояния.
 *
 * ### Batch correction: всё или ничего
 *
 * Одно событие несёт весь снимок — портфель, заявки, исполнения — и
 * применяется ОДНОЙ мутацией с ОДНИМ приращением версии. Частично применённая
 * коррекция («портфель принят, четвёртая заявка отвергнута») оставила бы
 * состояние, которого не было ни у нас, ни у площадки.
 *
 * ### `expectedAccountVersion` — optimistic concurrency
 *
 * Снимок строится ДОЛГО: несколько запросов к источнику. Пока они идут, живой
 * контур продолжает менять аккаунт. Снимок, основанный на версии 100, нельзя
 * накладывать поверх версии 101: он не видел изменения, которое её создало,
 * и откатил бы его.
 *
 * ```text
 * reconciler читает аккаунт           version = 100 → expectedAccountVersion
 * идут запросы к источнику
 *   тем временем живое событие       version = 101
 * TRADING_ACCOUNT_RECONCILED(100)    → конфликт версий, НИЧЕГО не меняется
 * ```
 *
 * Конфликт — нормальная гонка, а не дефект: устаревший снимок отбрасывается, и
 * сверка повторяется со свежим чтением.
 *
 * ### Upsert, а не replace
 *
 * Заявки и исполнения, которых нет в payload, остаются в состоянии историей:
 * событие исправляет то, о чём сообщает, и не утверждает ничего о том, о чём
 * молчит.
 *
 * ### Чего в payload нет
 *
 * Ни vendor-DTO, ни сырого JSON, ни vendor-статусов, ни причины запуска
 * сверки: только canonical domain-сущности. Момент применения — это
 * `metadata.createdAt`; отдельного `reconciledAt` нет по той же причине, что и
 * у остальных событий контура.
 *
 * ### Producer
 *
 * `AccountReconciler` (`@polymarket/account-reconciliation`).
 *
 * @example
 * ```typescript
 * const event = {
 *   type: 'TRADING_ACCOUNT_RECONCILED',
 *   payload: { venueId, accountId, expectedAccountVersion: 100, portfolio, orders, fills },
 *   metadata: metadataGenerator.nextRoot(),
 * } satisfies TradingAccountReconciledEvent;
 * ```
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { AccountId, VenueId } from '@polymarket/ids';
import type { Fill } from '@polymarket/fill';
import type { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';

export type TradingAccountReconciledEvent = MessageEnvelope<
  'TRADING_ACCOUNT_RECONCILED',
  {
    /** Площадка аккаунта — обязательная часть его идентичности */
    readonly venueId: VenueId;
    /** Сверяемый аккаунт */
    readonly accountId: AccountId;
    /**
     * Версия аккаунта, на которой основан снимок.
     *
     * @remarks
     * Коррекция применяется, только если текущая версия аккаунта РАВНА этой.
     * Иначе снимок устарел и отбрасывается целиком — без мутации, без
     * приращения версий и без изменения `lastMutationAt`.
     */
    readonly expectedAccountVersion: number;
    /**
     * Authoritative-портфель — экономическая истина аккаунта.
     *
     * @remarks
     * Принимается ЦЕЛИКОМ и из заявок/исполнений НЕ пересчитывается. Все
     * инварианты `Portfolio` (владение, `Position.quantity == available +
     * reserved` токенов) уже выполнены его конструктором.
     */
    readonly portfolio: Portfolio;
    /**
     * Authoritative-состояние заявок.
     *
     * @remarks
     * Открытые заявки площадки плюс настоящее состояние тех локально открытых,
     * которых среди открытых не оказалось. Неизвестная заявка вставляется,
     * известная с тем же состоянием — no-op, с изменённым состоянием —
     * заменяется; неизменяемая идентичность обязана совпасть.
     */
    readonly orders: readonly Order[];
    /**
     * Исполнения, существование которых подтвердила площадка.
     *
     * @remarks
     * На оси рантайма они authoritative-подтверждены: новое записывается сразу
     * `CONFIRMED`, `APPLIED` переходит в `CONFIRMED`. Venue-ось
     * (`TradeStatus`) коррекцией не трогается.
     */
    readonly fills: readonly Fill[];
  }
>;

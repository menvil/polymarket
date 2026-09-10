/**
 * `@polymarket/account-state` — приватное состояние торгового аккаунта.
 *
 * @remarks
 * Второй фундаментальный слой состояния нового торгового рантайма. Первый —
 * `@polymarket/trading-state` — отвечает на вопрос «что происходит на рынке».
 * Этот отвечает на вопрос «что происходит с НАМИ».
 *
 * ```text
 * PUBLIC / MARKET STATE          PRIVATE / ACCOUNT STATE
 * TradingHotState                AccountHotState
 *   market metadata                portfolio
 *   books                          our orders
 *   public trades                  our fills
 *   CEX                            positions через Portfolio
 *   reference prices
 *   market lifecycle
 * ```
 *
 * Два read-model НЕ объединяются в одно гигантское состояние: стакан и лента
 * — публичные наблюдения, доступные любому участнику, а баланс, заявки и
 * исполнения — приватные факты одного аккаунта. Пакеты друг от друга не
 * зависят и обрабатывают разные типы событий. Согласованный снимок из обоих
 * позже соберёт `TradingContextBuilder` как read-only потребитель.
 *
 * ### Как состояние наполняется
 *
 * ```text
 * приватное наблюдение / команда
 *   ↓
 * domain/execution processing         ← здесь считается ВСЯ экономика
 *   ↓
 * post-commit Order / Portfolio / Fill
 *   ↓
 * TRADING_ACCOUNT_*                   ← здесь уже только итог
 *   ↓
 * IEventBus → AccountStateProjector → AccountHotState
 * ```
 *
 * Проектор НЕ считает резервации, комиссии, FIFO-лоты и допустимость
 * переходов заявки: всё это уже посчитано producer'ом. Он проверяет
 * согласованность и материализует готовые immutable snapshot'ы.
 *
 * ### Три сущности и их роли
 *
 * ```text
 * Portfolio          ЕДИНСТВЕННЫЙ источник истины: деньги + позиции + резервации
 * Order              текущее состояние НАШЕЙ заявки
 * Fill               неизменяемый факт исполнения
 * AccountFillRecord  runtime-жизненный цикл вокруг этого факта
 * ```
 *
 * Параллельных `balance`/`positions`/`tokenReservations` в состоянии нет:
 * второй источник истины по деньгам неизбежно разошёлся бы с первым.
 *
 * ### Идентичность аккаунта — ПАРА «площадка + аккаунт»
 *
 * ```text
 * getAccount(venueId, accountId)
 * accountIdentities() → [{ venueId, accountId }, …]
 * ```
 *
 * Ключ второго уровня — canonical строка `accountIdToString`, а не сам
 * объект: два эквивалентных `AccountId`, собранных в разных местах, обязаны
 * находить ОДИН аккаунт.
 *
 * ### Что видно снаружи
 *
 * Только проектор, read-only проекции, типы записей, помощники сравнения
 * идентичности и ошибки инвариантов. Mutable-классы состояния
 * (`AccountHotState`, `AccountRuntimeState`) НЕ экспортируются: иначе правило
 * «единственный писатель — проектор» осталось бы комментарием.
 *
 * Reconciliation, strategy, risk и execution в этот слой не входят — они
 * строятся НАД готовым состоянием отдельными этапами.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * const projector = AccountStateProjector.create(eventBus);
 * projector.start();
 *
 * await eventBus.publish(initializedEvent);   // аккаунт появляется в состоянии
 * await eventBus.publish(orderCommittedEvent); // заявка + портфель одной мутацией
 *
 * const view: AccountHotStateView = projector.state();
 * const account = view.getAccount(venueId, accountId);
 * account?.portfolio.balance.available();
 * account?.openOrders();
 * account?.getPosition(instrumentId);
 * ```
 */
export { AccountStateProjector } from './AccountStateProjector.js';
export { OPEN_ORDER_STATUSES } from './AccountHotState.js';
export {
  AccountAlreadyInitializedError,
  AccountFillIdentityConflictError,
  AccountFillNotFoundError,
  AccountFillOrderLinkError,
  AccountFillTransitionError,
  AccountIdentityMismatchError,
  AccountInstrumentResolutionError,
  AccountNotInitializedError,
  AccountOrderAccountMissingError,
  AccountOrderIdentityConflictError,
  AccountPortfolioIdentityMismatchError,
  type AccountFillAction,
  type AccountFillOrderLinkField,
  type AccountIdentityMismatchSubject,
  type AccountInstrumentSubject,
  type AccountPortfolioIdentityField,
  type AccountStateError,
} from './errors.js';
export { accountKey, embeddedVenueId } from './identity.js';
export type {
  AccountFillRecord,
  AccountFillStatus,
  AccountOrderRecord,
} from './records.js';
export type {
  AccountHotStateView,
  AccountRuntimeStateView,
  TradingAccountIdentity,
} from './views.js';

/**
 * Приватное оперативное состояние торговых аккаунтов.
 *
 * @remarks
 * Строится ТОЛЬКО из canonical `TRADING_ACCOUNT_*` событий. Ни источников, ни
 * вендорских DTO, ни wall-clock здесь нет: повтор той же последовательности
 * событий даёт то же состояние.
 *
 * ```text
 * AccountHotState
 * ├── accounts
 * │   └── VenueId
 * │       └── accountIdToString(AccountId)
 * │           └── AccountRuntimeState
 * │                 ├── portfolio   деньги + позиции + резервации
 * │                 ├── orders      OrderId → AccountOrderRecord
 * │                 └── fills       FillId  → AccountFillRecord
 * └── version        принятые мутации по ВСЕМ аккаунтам
 * ```
 *
 * ### Навигация — производные представления, а не хранимое состояние
 *
 * ```text
 * orders / fills          единственный источник истины
 *      ↓ scan + filter
 * ordersForInstrument / fillsForInstrument / fillsForOrder
 * ```
 *
 * Вторичные индексы намеренно НЕ хранятся. Хранимый индекс — это mutable
 * derived state, который обязан обновляться синхронно с каноническими
 * коллекциями в каждой мутации; на ожидаемом сейчас масштабе заявок и
 * исполнений линейный проход по `Map` дешевле этой обязанности. Публичный
 * контракт навигации от решения не зависит: {@link AccountRuntimeStateView}
 * описывает результат, а не способ его получить, поэтому внутренний индекс
 * можно завести позже, когда профилирование покажет необходимость.
 *
 * ### Экономика считается ВЫШЕ, а не здесь
 *
 * Ни резерваций, ни FIFO, ни BUY/SELL-учёта, ни допустимости перехода заявки
 * в этом модуле нет и быть не должно. Всё это посчитано producer'ом ДО
 * публикации события, и payload несёт готовые immutable snapshot'ы. Состояние
 * их ПРОВЕРЯЕТ и МАТЕРИАЛИЗУЕТ — вторая реализация экономики рядом с первой
 * неизбежно с ней разошлась бы.
 *
 * ### Validation-first, mutation-second
 *
 * Каждый метод сначала полностью валидирует событие и только потом мутирует.
 * Отвергнутое событие не оставляет за собой НИЧЕГО: ни портфеля, ни записи,
 * ни изменения версий, ни `lastMutationAt`. Частичная мутация — уже пойманный
 * в этом проекте класс дефекта, и повторять его нельзя.
 *
 * ### Три исхода вместо двух
 *
 * ```text
 * новый факт / законное обновление   применить, version += 1
 * точный дубликат доставки           no-op, версии не меняются
 * та же идентичность, другой факт     Err, состояние не меняется
 * ```
 *
 * Дубликат — нормальная доставка, а не ошибка. Но применить его нельзя: он
 * несёт УСТАРЕВШИЙ портфель, и слепое применение откатило бы состояние назад.
 * Исключение — инициализация аккаунта: это ownership-событие, и его повтор
 * является нарушением lifecycle.
 *
 * ### Хранение — на время жизни рантайма
 *
 * Заявок и исполнений на порядки меньше, чем публичных обновлений стакана,
 * поэтому окон, `maxAge`, `maxCount` и компакции здесь нет. Долговременная
 * история появится вместе с персистентностью исполнения и аккаунта — вводить
 * её раньше значило бы угадывать политику под несуществующую нагрузку.
 */
import {
  accountIdEquals,
  accountIdToString,
  assetIdToInstrumentId,
  assetIdToString,
  AssetIdHelpers,
  type AccountId,
  type FillId,
  type InstrumentId,
  type OrderId,
  type VenueId,
} from '@polymarket/ids';
import { findFillFactDifference, type Fill } from '@polymarket/fill';
import {
  findOrderIdentityDifference,
  sameOrderState,
  type Order,
  type OrderStatus,
} from '@polymarket/order';
import type { IPosition, Portfolio } from '@polymarket/portfolio';
import { Err, Ok, type Result } from '@polymarket/result';
import type { Timestamp } from '@polymarket/timestamp';
import {
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
  type AccountStateError,
} from './errors.js';
import { accountKey, embeddedVenueId } from './identity.js';
import type { AccountFillRecord, AccountOrderRecord } from './records.js';
import type {
  AccountHotStateView,
  AccountRuntimeStateView,
  TradingAccountIdentity,
} from './views.js';

/**
 * Статусы заявки, которые считаются живой экспозицией.
 *
 * @remarks
 * Перечислены ЯВНО, а не выведены как дополнение `TERMINAL_STATUSES`. Дело не
 * в текущем составе — сегодня это в точности дополнение, и тест полноты по
 * `TERMINAL_STATUSES` за этим следит. Дело в том, что новый нетерминальный
 * статус, добавленный в `@polymarket/order` завтра, при выводе через
 * отрицание молча стал бы «открытым». Здесь он сломает тест полноты и
 * потребует осознанного решения.
 *
 * `PENDING` входит СОЗНАТЕЛЬНО: заявка отправлена, деньги или токены под неё
 * зарезервированы, и для риска это уже принятое обязательство — независимо от
 * того, ответила площадка или нет.
 */
export const OPEN_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'PENDING',
  'OPEN',
  'PARTIALLY_FILLED',
]);

/**
 * Изменения одной принятой мутации, вычисленные ДО записи.
 *
 * @remarks
 * Существует затем, чтобы между «проверить» и «записать» не оставалось ни
 * одной операции, способной отказать: всё, что могло не пройти, уже прошло.
 */
interface PendingMutation {
  /** Post-commit портфель; `undefined` — портфель не меняется (подтверждение) */
  readonly portfolio?: Portfolio;
  /** Post-commit заявка; `undefined` — заявка этим событием не менялась */
  readonly order?: Order;
  /**
   * Запись исполнения целиком; `undefined` — исполнения событие не касается.
   *
   * @remarks
   * Новое исполнение и смена его runtime-статуса записываются одинаково:
   * навигация — производное представление поверх `_fills`, поэтому «вставка»
   * и «переход» отличаются только содержимым записи, а не работой с
   * состоянием.
   */
  readonly fill?: AccountFillRecord;
}

/**
 * Состояние одного торгового аккаунта.
 *
 * @remarks
 * Класс НЕ экспортируется из пакета: наружу выходит только
 * {@link AccountRuntimeStateView}. Иначе правило «единственный писатель —
 * проектор» осталось бы комментарием.
 *
 * Позиции и деньги живут в `_portfolio` и только там. Параллельных
 * `positions`/`balance`/`tokenReservations` у аккаунта нет — см. `views.ts`.
 */
class AccountRuntimeState implements AccountRuntimeStateView {
  private readonly _orders = new Map<OrderId, AccountOrderRecord>();
  private readonly _fills = new Map<FillId, AccountFillRecord>();
  private _portfolio: Portfolio;
  private _version: number;
  private _lastMutationAt: Timestamp;

  /**
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт в том виде, в каком он принят
   * @param portfolio - Портфель на момент инициализации
   * @param initializedAt - `metadata.createdAt` события инициализации
   *
   * @remarks
   * Инициализация — это уже ПЕРВАЯ принятая мутация, поэтому версия
   * начинается с 1: «аккаунт есть» — само по себе изменение состояния.
   */
  constructor(
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    portfolio: Portfolio,
    initializedAt: Timestamp,
  ) {
    this._portfolio = portfolio;
    this._version = 1;
    this._lastMutationAt = initializedAt;
  }

  /** {@inheritDoc AccountRuntimeStateView.portfolio} */
  public get portfolio(): Portfolio {
    return this._portfolio;
  }

  /** {@inheritDoc AccountRuntimeStateView.version} */
  public get version(): number {
    return this._version;
  }

  /** {@inheritDoc AccountRuntimeStateView.lastMutationAt} */
  public get lastMutationAt(): Timestamp {
    return this._lastMutationAt;
  }

  /** {@inheritDoc AccountRuntimeStateView.getOrder} */
  public getOrder(orderId: OrderId): AccountOrderRecord | undefined {
    return this._orders.get(orderId);
  }

  /** {@inheritDoc AccountRuntimeStateView.orders} */
  public orders(): readonly AccountOrderRecord[] {
    return [...this._orders.values()];
  }

  /** {@inheritDoc AccountRuntimeStateView.openOrders} */
  public openOrders(): readonly AccountOrderRecord[] {
    return this.orders().filter((record) => OPEN_ORDER_STATUSES.has(record.order.status));
  }

  /** {@inheritDoc AccountRuntimeStateView.ordersForInstrument} */
  public ordersForInstrument(instrumentId: InstrumentId): readonly AccountOrderRecord[] {
    return this.orders().filter(
      (record) => assetIdToInstrumentId(record.order.asset) === instrumentId,
    );
  }

  /** {@inheritDoc AccountRuntimeStateView.getFill} */
  public getFill(fillId: FillId): AccountFillRecord | undefined {
    return this._fills.get(fillId);
  }

  /** {@inheritDoc AccountRuntimeStateView.fills} */
  public fills(): readonly AccountFillRecord[] {
    return [...this._fills.values()];
  }

  /** {@inheritDoc AccountRuntimeStateView.fillsForOrder} */
  public fillsForOrder(orderId: OrderId): readonly AccountFillRecord[] {
    return this.fills().filter((record) => record.fill.orderId === orderId);
  }

  /** {@inheritDoc AccountRuntimeStateView.fillsForInstrument} */
  public fillsForInstrument(instrumentId: InstrumentId): readonly AccountFillRecord[] {
    return this.fills().filter(
      (record) => assetIdToInstrumentId(record.fill.tokenId) === instrumentId,
    );
  }

  /** {@inheritDoc AccountRuntimeStateView.getPosition} */
  public getPosition(instrumentId: InstrumentId): IPosition | undefined {
    return this._portfolio.getPosition(instrumentId);
  }

  /**
   * Применяет уже проверенные изменения одной мутацией.
   *
   * @param mutation - Изменения, вычисленные на этапе валидации
   * @param at - `metadata.createdAt` принятого события
   *
   * @remarks
   * Единственное место, где состояние аккаунта меняется. Ни одна операция
   * внутри не может отказать — всё проверено вызывающим, — поэтому
   * «наполовину применённого» события не бывает.
   *
   * Версия растёт РОВНО на единицу за ОДНУ принятую canonical-мутацию,
   * сколько бы её частей — портфель, заявка, исполнение — она ни затронула:
   * считается принятое событие, а не число изменённых структур.
   */
  public commit(mutation: PendingMutation, at: Timestamp): void {
    if (mutation.portfolio !== undefined) {
      this._portfolio = mutation.portfolio;
    }

    if (mutation.order !== undefined) {
      this._orders.set(mutation.order.id, { order: mutation.order, updatedAt: at });
    }

    if (mutation.fill !== undefined) {
      this._fills.set(mutation.fill.fill.id, mutation.fill);
    }

    this._version += 1;
    this._lastMutationAt = at;
  }
}

/**
 * Приватное состояние всех торговых аккаунтов рантайма.
 *
 * @remarks
 * Класс НЕ экспортируется из пакета — см. `index.ts`. Единственный вход в
 * него снаружи — `AccountStateProjector`.
 *
 * @example
 * ```typescript
 * const state = new AccountHotState();
 * const applied = state.initializeAccount(venueId, accountId, portfolio, createdAt);
 * if (isErr(applied)) throw applied.error;
 * state.getAccount(venueId, accountId)?.version; // → 1
 * ```
 */
export class AccountHotState implements AccountHotStateView {
  private readonly _accounts = new Map<VenueId, Map<string, AccountRuntimeState>>();
  private _version = 0;

  /** {@inheritDoc AccountHotStateView.getVersion} */
  public getVersion(): number {
    return this._version;
  }

  /** {@inheritDoc AccountHotStateView.getAccount} */
  public getAccount(venueId: VenueId, accountId: AccountId): AccountRuntimeStateView | undefined {
    return this._resolve(venueId, accountId);
  }

  /** {@inheritDoc AccountHotStateView.accountIdentities} */
  public accountIdentities(): readonly TradingAccountIdentity[] {
    const identities: TradingAccountIdentity[] = [];
    for (const accounts of this._accounts.values()) {
      for (const account of accounts.values()) {
        identities.push({ venueId: account.venueId, accountId: account.accountId });
      }
    }
    return identities;
  }

  /**
   * Принимает аккаунт к работе — единственный способ создать его состояние.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @param portfolio - Портфель на момент принятия
   * @param at - `metadata.createdAt` события
   * @returns `Ok(void)` при успехе, иначе первая непройденная проверка
   *
   * @remarks
   * Проверяется, в этом порядке:
   *
   * ```text
   * 1. аккаунт ещё не инициализирован
   * 2. встроенная в AccountId площадка совпадает с payload (если она есть)
   * 3. portfolio.accountId          совпадает с accountId
   * 4. portfolio.balance.accountId() совпадает с accountId
   * 5. portfolio.balance.venueId()   совпадает с venueId
   * ```
   *
   * Пункт 2 не применяется к WALLET-аккаунту: встроенной площадки у него нет
   * вовсе, и её отсутствие — норма, а не расхождение.
   *
   * @example
   * ```typescript
   * const applied = state.initializeAccount(venueId, accountId, portfolio, createdAt);
   * ```
   */
  public initializeAccount(
    venueId: VenueId,
    accountId: AccountId,
    portfolio: Portfolio,
    at: Timestamp,
  ): Result<void, AccountStateError> {
    const existing = this._resolve(venueId, accountId);
    if (existing !== undefined) {
      return Err(new AccountAlreadyInitializedError(venueId, accountId, existing.version));
    }

    const embedded = embeddedVenueId(accountId);
    if (embedded !== undefined && embedded !== venueId) {
      return Err(
        new AccountIdentityMismatchError(
          'VENUE_BOUND_ACCOUNT',
          venueId,
          accountId,
          venueId,
          embedded,
        ),
      );
    }

    const portfolioIdentity = validatePortfolioIdentity(venueId, accountId, portfolio);
    if (portfolioIdentity !== undefined) return Err(portfolioIdentity);

    const account = new AccountRuntimeState(venueId, accountId, portfolio, at);
    let byAccount = this._accounts.get(venueId);
    if (byAccount === undefined) {
      byAccount = new Map<string, AccountRuntimeState>();
      this._accounts.set(venueId, byAccount);
    }
    byAccount.set(accountKey(accountId), account);
    this._version += 1;
    return Ok(undefined);
  }

  /**
   * Материализует итоговую заявку вместе с итоговым портфелем.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт-владелец
   * @param order - Post-commit заявка
   * @param portfolio - Post-commit портфель
   * @param at - `metadata.createdAt` события
   * @returns `Ok(void)` при успехе или при дубликате, иначе первая непройденная проверка
   *
   * @remarks
   * Допустимость перехода самой заявки НЕ проверяется: этим владеет producer,
   * а событие несёт уже зафиксированный итог. Здесь проверяется
   * СОГЛАСОВАННОСТЬ — что заявка принадлежит этому аккаунту, что она не
   * подменена другой под тем же идентификатором и что её актив связывается с
   * инструментом.
   *
   * Точный дубликат (та же заявка в том же состоянии) — no-op: портфель из
   * него УСТАРЕВШИЙ, и применение откатило бы состояние назад.
   *
   * @example
   * ```typescript
   * state.commitOrder(venueId, accountId, partiallyFilled, portfolioAfter, createdAt);
   * ```
   */
  public commitOrder(
    venueId: VenueId,
    accountId: AccountId,
    order: Order,
    portfolio: Portfolio,
    at: Timestamp,
  ): Result<void, AccountStateError> {
    const account = this._resolve(venueId, accountId);
    if (account === undefined) {
      return Err(new AccountNotInitializedError(venueId, accountId, 'ORDER_COMMITTED'));
    }

    const portfolioIdentity = validatePortfolioIdentity(venueId, accountId, portfolio);
    if (portfolioIdentity !== undefined) return Err(portfolioIdentity);

    const owner = validateOrderOwner(venueId, accountId, order);
    if (owner !== undefined) return Err(owner);

    // Значение не используется дальше: инструмент вычисляется на чтении.
    // Проверка остаётся — заявка, которую нельзя связать с рынком, не должна
    // попадать в состояние.
    if (assetIdToInstrumentId(order.asset) === undefined) {
      return Err(
        new AccountInstrumentResolutionError(
          'ORDER_ASSET',
          venueId,
          accountId,
          assetIdToString(order.asset),
        ),
      );
    }

    const stored = account.getOrder(order.id);
    if (stored !== undefined) {
      const difference = findOrderIdentityDifference(stored.order, order);
      if (difference !== undefined) {
        return Err(
          new AccountOrderIdentityConflictError(venueId, accountId, order.id, difference),
        );
      }
      // Точный дубликат: применять нечего, а портфель события устарел.
      if (sameOrderState(stored.order, order)) return Ok(undefined);
    }

    account.commit({ portfolio, order }, at);
    this._version += 1;
    return Ok(undefined);
  }

  /**
   * Материализует применённое исполнение вместе с итоговым портфелем.
   *
   * @param fill - Canonical факт исполнения (несёт venue и аккаунт)
   * @param portfolio - Post-commit портфель
   * @param order - Post-commit заявка, если она изменилась тем же событием
   * @param at - `metadata.createdAt` события
   * @returns `Ok(void)` при успехе или при дубликате, иначе первая непройденная проверка
   *
   * @remarks
   * Экономика исполнения здесь НЕ считается: комиссия, движение денег и
   * изменение позиции уже учтены в `portfolio`.
   *
   * Исполнение, заявка и портфель обновляются ОДНОЙ принятой мутацией: иначе
   * состояние на мгновение показало бы исполнение без соответствующего
   * `filledSize` — ровно в тот момент, когда по нему принимается решение.
   *
   * @example
   * ```typescript
   * state.applyFill(fill, portfolioAfter, orderAfter, createdAt);
   * ```
   */
  public applyFill(
    fill: Fill,
    portfolio: Portfolio,
    order: Order | undefined,
    at: Timestamp,
  ): Result<void, AccountStateError> {
    const prepared = this._prepareFillEconomicEvent(fill, portfolio, order, 'APPLY');
    if (!prepared.ok) return prepared;

    const account = prepared.value;
    // Тот же FillId с тем же фактом (расхождение уже отвергнуто выше) — это
    // дубликат доставки: портфель и заявка в нём УСТАРЕВШИЕ, применять их
    // нельзя, иначе повторный старый event откатил бы состояние назад.
    if (account.getFill(fill.id) !== undefined) return Ok(undefined);

    account.commit(
      {
        portfolio,
        ...(order === undefined ? {} : { order }),
        fill: { fill, status: 'APPLIED', appliedAt: at },
      },
      at,
    );
    this._version += 1;
    return Ok(undefined);
  }

  /**
   * Отмечает исполнение финальным.
   *
   * @param fill - Тот же canonical факт, что был применён
   * @param at - `metadata.createdAt` события
   * @returns `Ok(void)` при успехе или при дубликате, иначе первая непройденная проверка
   *
   * @remarks
   * Ни портфель, ни заявка НЕ меняются: экономика применена раньше, а
   * подтверждение относится только к уверенности в факте. Именно поэтому
   * payload события их и не несёт.
   *
   * Подтверждение неизвестного исполнения отвергается: угадать пропущенный
   * экономический эффект нельзя.
   *
   * @example
   * ```typescript
   * state.confirmFill(fill, createdAt);
   * ```
   */
  public confirmFill(fill: Fill, at: Timestamp): Result<void, AccountStateError> {
    const stored = this._resolveStoredFill(fill, 'CONFIRM');
    if (!stored.ok) return stored;

    const { account, record } = stored.value;
    if (record.status === 'CONFIRMED') return Ok(undefined);
    if (record.status === 'REVERTED') {
      return Err(
        new AccountFillTransitionError(
          account.venueId,
          account.accountId,
          fill.id,
          record.status,
          'CONFIRMED',
        ),
      );
    }

    account.commit({ fill: { ...record, status: 'CONFIRMED', confirmedAt: at } }, at);
    this._version += 1;
    return Ok(undefined);
  }

  /**
   * Откатывает ранее применённое исполнение.
   *
   * @param fill - Тот же canonical факт, что был применён
   * @param portfolio - Портфель ПОСЛЕ отката, посчитанный upstream-ом
   * @param order - Заявка после отката, если она изменилась
   * @param reason - Причина отката для диагностики
   * @param at - `metadata.createdAt` события
   * @returns `Ok(void)` при успехе или при дубликате, иначе первая непройденная проверка
   *
   * @remarks
   * Реверс здесь НЕ считается — payload несёт уже пересчитанное состояние.
   *
   * `CONFIRMED → REVERTED` отвергается: финальность на то и финальность.
   * Повторный откат уже откаченного исполнения — no-op, и `revertReason`
   * остаётся тем, который проставил ПЕРВЫЙ принятый откат: повторная
   * доставка не переписывает историю.
   *
   * @example
   * ```typescript
   * state.revertFill(fill, portfolioAfterRevert, orderAfterRevert, 'venue FAILED', createdAt);
   * ```
   */
  public revertFill(
    fill: Fill,
    portfolio: Portfolio,
    order: Order | undefined,
    reason: string,
    at: Timestamp,
  ): Result<void, AccountStateError> {
    const prepared = this._prepareFillEconomicEvent(fill, portfolio, order, 'REVERT');
    if (!prepared.ok) return prepared;

    const account = prepared.value;
    const record = account.getFill(fill.id);
    if (record === undefined) {
      return Err(
        new AccountFillNotFoundError(account.venueId, account.accountId, fill.id, 'REVERT'),
      );
    }
    if (record.status === 'REVERTED') return Ok(undefined);
    if (record.status === 'CONFIRMED') {
      return Err(
        new AccountFillTransitionError(
          account.venueId,
          account.accountId,
          fill.id,
          record.status,
          'REVERTED',
        ),
      );
    }

    account.commit(
      {
        portfolio,
        ...(order === undefined ? {} : { order }),
        fill: { ...record, status: 'REVERTED', revertedAt: at, revertReason: reason },
      },
      at,
    );
    this._version += 1;
    return Ok(undefined);
  }

  /**
   * Находит состояние аккаунта по паре «площадка + аккаунт».
   *
   * @param venueId - Площадка
   * @param accountId - Аккаунт
   * @returns Состояние либо `undefined`
   *
   * @remarks
   * Ключ второго уровня — canonical строка, поэтому два эквивалентных
   * `AccountId`, собранных в разных местах, находят один и тот же аккаунт.
   */
  private _resolve(venueId: VenueId, accountId: AccountId): AccountRuntimeState | undefined {
    return this._accounts.get(venueId)?.get(accountKey(accountId));
  }

  /**
   * Общая валидация событий, несущих экономику исполнения.
   *
   * @param fill - Canonical факт исполнения
   * @param portfolio - Post-commit портфель
   * @param order - Post-commit заявка, если она есть
   * @param action - Какое событие обрабатывается (для текста ошибки)
   * @returns Разрешённый аккаунт либо первая непройденная проверка
   *
   * @remarks
   * `TRADING_ACCOUNT_FILL_APPLIED` и `TRADING_ACCOUNT_FILL_REVERTED`
   * проверяются одинаково: оба несут `Fill` + `Portfolio` + опциональную
   * заявку и оба обязаны быть согласованы внутри себя. Различаются они только
   * тем, что делают с найденной записью.
   *
   * Проверки идут ДО различения «новый факт / дубликат / конфликт»: событие,
   * несогласованное внутри себя, остаётся дефектом producer'а независимо от
   * того, видели мы это исполнение раньше или нет.
   */
  private _prepareFillEconomicEvent(
    fill: Fill,
    portfolio: Portfolio,
    order: Order | undefined,
    action: Extract<AccountFillAction, 'APPLY' | 'REVERT'>,
  ): Result<AccountRuntimeState, AccountStateError> {
    const venueId = fill.venueId;
    const accountId = fill.accountId;

    const account = this._resolve(venueId, accountId);
    if (account === undefined) {
      return Err(
        new AccountNotInitializedError(
          venueId,
          accountId,
          action === 'APPLY' ? 'FILL_APPLIED' : 'FILL_REVERTED',
        ),
      );
    }

    const portfolioIdentity = validatePortfolioIdentity(venueId, accountId, portfolio);
    if (portfolioIdentity !== undefined) return Err(portfolioIdentity);

    // Значение не используется дальше: инструмент вычисляется на чтении.
    // Проверка остаётся — исполнение, которое нельзя связать с рынком, не
    // должно попадать в состояние.
    if (assetIdToInstrumentId(fill.tokenId) === undefined) {
      return Err(
        new AccountInstrumentResolutionError(
          'FILL_TOKEN',
          venueId,
          accountId,
          assetIdToString(fill.tokenId),
        ),
      );
    }

    if (order !== undefined) {
      const link = validateFillOrderLink(venueId, accountId, fill, order);
      if (link !== undefined) return Err(link);

      // Отдельно инструмент заявки НЕ проверяется: `validateFillOrderLink`
      // уже доказал `order.asset === fill.tokenId`, а его разрешимость
      // проверена выше. Второй вызов `assetIdToInstrumentId` дал бы
      // недостижимую ветку отказа и второе место, где живёт одно решение.
      const storedOrder = account.getOrder(order.id);
      if (storedOrder !== undefined) {
        const difference = findOrderIdentityDifference(storedOrder.order, order);
        if (difference !== undefined) {
          return Err(
            new AccountOrderIdentityConflictError(venueId, accountId, order.id, difference),
          );
        }
      }
    }

    const storedFill = account.getFill(fill.id);
    if (storedFill !== undefined) {
      const difference = findFillFactDifference(storedFill.fill, fill);
      if (difference !== undefined) {
        return Err(
          new AccountFillIdentityConflictError(venueId, accountId, fill.id, action, difference),
        );
      }
    }

    return Ok(account);
  }

  /**
   * Находит уже сохранённую запись исполнения и сверяет факт.
   *
   * @param fill - Canonical факт из события
   * @param action - Какое событие обрабатывается
   * @returns Аккаунт и запись либо первая непройденная проверка
   *
   * @remarks
   * Используется подтверждением: оно не несёт ни портфеля, ни заявки, поэтому
   * его валидация короче — аккаунт, наличие записи, совпадение факта.
   */
  private _resolveStoredFill(
    fill: Fill,
    action: Extract<AccountFillAction, 'CONFIRM'>,
  ): Result<{ account: AccountRuntimeState; record: AccountFillRecord }, AccountStateError> {
    const venueId = fill.venueId;
    const accountId = fill.accountId;

    const account = this._resolve(venueId, accountId);
    if (account === undefined) {
      return Err(new AccountNotInitializedError(venueId, accountId, 'FILL_CONFIRMED'));
    }

    const record = account.getFill(fill.id);
    if (record === undefined) {
      return Err(new AccountFillNotFoundError(venueId, accountId, fill.id, action));
    }

    const difference = findFillFactDifference(record.fill, fill);
    if (difference !== undefined) {
      return Err(
        new AccountFillIdentityConflictError(venueId, accountId, fill.id, action, difference),
      );
    }

    return Ok({ account, record });
  }
}

/**
 * Сверяет идентичность портфеля с идентичностью аккаунта.
 *
 * @param venueId - Площадка владельца
 * @param accountId - Аккаунт владельца
 * @param portfolio - Портфель из события
 * @returns Ошибку при первом расхождении либо `undefined`
 *
 * @remarks
 * Проверяются все три места, где идентичность продублирована:
 * `portfolio.accountId`, `portfolio.balance.accountId()` и
 * `portfolio.balance.venueId()`. Проверять только первое недостаточно —
 * `Balance` хранит собственную пару, и агрегат с правильным владельцем может
 * нести баланс чужой площадки.
 */
function validatePortfolioIdentity(
  venueId: VenueId,
  accountId: AccountId,
  portfolio: Portfolio,
): AccountPortfolioIdentityMismatchError | undefined {
  const expected = accountIdToString(accountId);

  if (!accountIdEquals(portfolio.accountId, accountId)) {
    return new AccountPortfolioIdentityMismatchError(
      'accountId',
      venueId,
      accountId,
      expected,
      accountIdToString(portfolio.accountId),
    );
  }

  const balanceAccountId = portfolio.balance.accountId();
  if (!accountIdEquals(balanceAccountId, accountId)) {
    return new AccountPortfolioIdentityMismatchError(
      'balanceAccountId',
      venueId,
      accountId,
      expected,
      accountIdToString(balanceAccountId),
    );
  }

  const balanceVenueId = portfolio.balance.venueId();
  if (balanceVenueId !== venueId) {
    return new AccountPortfolioIdentityMismatchError(
      'balanceVenueId',
      venueId,
      accountId,
      venueId,
      balanceVenueId,
    );
  }

  return undefined;
}

/**
 * Сверяет владельца заявки с владельцем из payload.
 *
 * @param venueId - Площадка владельца
 * @param accountId - Аккаунт владельца
 * @param order - Заявка из события
 * @returns Ошибку либо `undefined`
 *
 * @remarks
 * Для нового торгового рантайма `order.accountId` обязателен: без владельца
 * нельзя ни отнести заявку к аккаунту, ни запретить отмену чужой. Сам
 * `Order` держит поле опциональным ради старых снапшотов — это отдельный
 * будущий cleanup домена, и ослаблять из-за него контракт приватного
 * состояния незачем.
 */
function validateOrderOwner(
  venueId: VenueId,
  accountId: AccountId,
  order: Order,
): AccountOrderAccountMissingError | AccountIdentityMismatchError | undefined {
  const owner = order.accountId;
  if (owner === undefined) {
    return new AccountOrderAccountMissingError(venueId, accountId, order.id);
  }
  if (!accountIdEquals(owner, accountId)) {
    return new AccountIdentityMismatchError(
      'ORDER_ACCOUNT',
      venueId,
      accountId,
      accountIdToString(accountId),
      accountIdToString(owner),
    );
  }
  return undefined;
}

/**
 * Сверяет связь заявки и исполнения внутри одного события.
 *
 * @param venueId - Площадка владельца
 * @param accountId - Аккаунт владельца
 * @param fill - Исполнение из события
 * @param order - Заявка из того же события
 * @returns Ошибку при первом расхождении либо `undefined`
 *
 * @remarks
 * Событие атомарно, поэтому либо оба факта относятся к одной сделке, либо
 * событие отвергается целиком. Частично применить его нельзя — в этом и
 * состоит смысл атомарности.
 */
function validateFillOrderLink(
  venueId: VenueId,
  accountId: AccountId,
  fill: Fill,
  order: Order,
): AccountStateError | undefined {
  const owner = order.accountId;
  if (owner === undefined) {
    return new AccountOrderAccountMissingError(venueId, accountId, order.id);
  }
  if (!accountIdEquals(owner, fill.accountId)) {
    return new AccountIdentityMismatchError(
      'FILL_ORDER_ACCOUNT',
      venueId,
      accountId,
      accountIdToString(fill.accountId),
      accountIdToString(owner),
    );
  }
  if (order.id !== fill.orderId) {
    return new AccountFillOrderLinkError(
      'orderId',
      venueId,
      accountId,
      fill.id,
      fill.orderId,
      order.id,
    );
  }
  if (!AssetIdHelpers.equals(order.asset, fill.tokenId)) {
    return new AccountFillOrderLinkError(
      'asset',
      venueId,
      accountId,
      fill.id,
      assetIdToString(fill.tokenId),
      assetIdToString(order.asset),
    );
  }
  return undefined;
}

/**
 * Ошибки инвариантов приватного состояния аккаунта.
 *
 * @remarks
 * Package-local: `ValidationError` описывает неверный ВХОД, тогда как здесь
 * нарушается инвариант уже накопленного состояния — для того, кто читает лог,
 * это разные вещи.
 *
 * Все ошибки — `critical`: приватное состояние отвечает на вопрос «сколько у
 * нас денег и какие у нас обязательства». Тихо разошедшийся ответ на него
 * дороже любого отказа. Подписки проектора critical, поэтому отказ виден
 * публикующей стороне как `Err` из `IEventBus.publish()`, а не глотается
 * шиной.
 *
 * **Что `critical: true` НЕ означает:** автоматическую остановку рантайма.
 * Отказ возвращается публикующей стороне, и что с ним делать — вопрос
 * композиции. Fail-closed живого контура обязан быть решён ДО включения
 * Strategy/Execution.
 *
 * ### Общее правило: ошибка приходит ДО мутации
 *
 * Каждая из этих ошибок возвращается на этапе валидации. Портфель, заявки,
 * исполнения, индексы, обе версии и `lastMutationAt` остаются нетронутыми.
 */
import { TradingError } from '@polymarket/errors';
import { accountIdToString, type AccountId, type FillId, type OrderId, type VenueId } from '@polymarket/ids';
import type { AccountFillFactDifference } from './fillIdentity.js';
import type { AccountOrderIdentityDifference } from './orderIdentity.js';
import type { AccountFillStatus } from './records.js';

/** Общий контекст ошибки: пара, адресующая аккаунт. */
function accountContext(venueId: VenueId, accountId: AccountId) {
  return { venueId, accountId: accountIdToString(accountId) };
}

/** Читаемая пара «площадка:аккаунт» для текста ошибки. */
function describeAccount(venueId: VenueId, accountId: AccountId): string {
  return `${venueId}/${accountIdToString(accountId)}`;
}

/**
 * Аккаунт уже принят приватным состоянием.
 *
 * @remarks
 * Повторный `TRADING_ACCOUNT_INITIALIZED` — не идемпотентное наблюдение и не
 * обновление портфеля. Инициализация создаёт состояние аккаунта с нуля:
 * портфель, пустые коллекции заявок и исполнений, версию. Принять её второй
 * раз значило бы либо стереть уже накопленные заявки и исполнения, либо молча
 * оставить старое состояние, притворившись, что мутация была.
 *
 * Это отличает инициализацию от всех остальных событий контура: там повтор —
 * нормальная доставка, здесь — нарушение lifecycle. Обновлять портфель умеют
 * `ORDER_COMMITTED`, `FILL_APPLIED` и `FILL_REVERTED`.
 *
 * @example
 * ```typescript
 * throw new AccountAlreadyInitializedError(venueId, accountId, 12);
 * ```
 */
export class AccountAlreadyInitializedError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт, по которому пришла повторная инициализация
   * @param currentVersion - Сколько мутаций аккаунт уже принял
   */
  constructor(
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    public readonly currentVersion: number,
  ) {
    super(
      `Trading account ${describeAccount(venueId, accountId)} is already initialized ` +
        `(version ${currentVersion}); initialization is not an update`,
      { context: { ...accountContext(venueId, accountId), currentVersion } },
    );
  }
}

/**
 * Событие пришло по аккаунту, которого приватное состояние не знает.
 *
 * @remarks
 * Аккаунт создаётся ТОЛЬКО через `TRADING_ACCOUNT_INITIALIZED`. Заводить его
 * лениво «от первой заявки» нельзя: портфель пришлось бы придумать, а
 * придуманный баланс — это неверные деньги, на которых немедленно начнут
 * приниматься решения.
 *
 * Покрывает и случай «такой аккаунт есть, но у ДРУГОЙ площадки»: аккаунт
 * ищется по паре `venueId + accountId`, поэтому событие чужой площадки не
 * находит ничего — и это правильный ответ, а не конфликт.
 *
 * @example
 * ```typescript
 * throw new AccountNotInitializedError(venueId, accountId, 'ORDER_COMMITTED');
 * ```
 */
export class AccountNotInitializedError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param venueId - Площадка из события
   * @param accountId - Аккаунт из события
   * @param action - Что пытались сделать
   */
  constructor(
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    public readonly action: string,
  ) {
    super(
      `Trading account ${describeAccount(venueId, accountId)} is not initialized; ` +
        `${action} rejected`,
      { context: { ...accountContext(venueId, accountId), action } },
    );
  }
}

/**
 * Где именно найдено расхождение идентичности.
 *
 * @remarks
 * - `VENUE_BOUND_ACCOUNT` — площадка, встроенная в сам `AccountId`, не
 *   совпала с `venueId` payload;
 * - `ORDER_ACCOUNT` — `order.accountId` не совпал с владельцем из payload;
 * - `FILL_ORDER_ACCOUNT` — `order.accountId` не совпал с `fill.accountId`.
 */
export type AccountIdentityMismatchSubject =
  | 'VENUE_BOUND_ACCOUNT'
  | 'ORDER_ACCOUNT'
  | 'FILL_ORDER_ACCOUNT';

/**
 * Вложенная идентичность не совпала с идентичностью владельца.
 *
 * @remarks
 * Один класс на три близких случая: во всех трёх внутри события лежит вторая
 * копия идентичности аккаунта, и она разошлась с первой. Разница между ними —
 * значение поля `subject`, а не отдельный вид отказа.
 *
 * ### Про `VENUE_BOUND_ACCOUNT`
 *
 * `AccountId` содержит площадку не всегда:
 *
 * ```text
 * VENUE       venue задан явно            → обязан совпасть с payload
 * SUBACCOUNT  venue = venue корня         → обязан совпасть, если корень VENUE
 * WALLET      venue не задан вовсе        → проверять нечего, это НЕ ошибка
 * ```
 *
 * Один и тот же кошелёк торгует на нескольких площадках, поэтому отсутствие
 * встроенной площадки у WALLET-аккаунта — норма, и такой аккаунт по этой
 * причине не отвергается.
 *
 * @example
 * ```typescript
 * throw new AccountIdentityMismatchError('ORDER_ACCOUNT', venueId, accountId, expected, actual);
 * ```
 */
export class AccountIdentityMismatchError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param subject - Где найдено расхождение
   * @param venueId - Площадка владельца
   * @param accountId - Аккаунт владельца
   * @param expected - Ожидавшееся значение (идентичность владельца)
   * @param actual - Значение, найденное внутри события
   */
  constructor(
    public readonly subject: AccountIdentityMismatchSubject,
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Trading account ${describeAccount(venueId, accountId)} identity mismatch ` +
        `(${subject}): expected ${expected}, got ${actual}`,
      { context: { ...accountContext(venueId, accountId), subject, expected, actual } },
    );
  }
}

/** Поле портфеля, которое разошлось с идентичностью аккаунта. */
export type AccountPortfolioIdentityField = 'accountId' | 'balanceAccountId' | 'balanceVenueId';

/**
 * Портфель принадлежит не тому аккаунту, к которому его применяют.
 *
 * @remarks
 * `Portfolio` — единственный источник истины по деньгам, позициям и
 * резервациям, поэтому положить в состояние чужой портфель значит начать
 * принимать решения по чужим деньгам. Проверяются все три места, где
 * идентичность продублирована:
 *
 * ```text
 * portfolio.accountId              владелец агрегата
 * portfolio.balance.accountId()    владелец баланса
 * portfolio.balance.venueId()      площадка баланса
 * ```
 *
 * Проверять только первое недостаточно: `Balance` хранит собственную пару
 * `accountId + venueId`, и агрегат с правильным владельцем может нести баланс
 * чужой площадки.
 *
 * @example
 * ```typescript
 * throw new AccountPortfolioIdentityMismatchError('balanceVenueId', venueId, accountId, 'POLYMARKET', 'KALSHI');
 * ```
 */
export class AccountPortfolioIdentityMismatchError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param field - Какое поле портфеля разошлось
   * @param venueId - Площадка владельца
   * @param accountId - Аккаунт владельца
   * @param expected - Ожидавшееся значение
   * @param actual - Значение внутри портфеля
   */
  constructor(
    public readonly field: AccountPortfolioIdentityField,
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Portfolio identity mismatch on ${field} for trading account ` +
        `${describeAccount(venueId, accountId)}: expected ${expected}, got ${actual}`,
      { context: { ...accountContext(venueId, accountId), field, expected, actual } },
    );
  }
}

/**
 * У заявки нет владельца.
 *
 * @remarks
 * Существующий domain-`Order` держит `accountId` опциональным ради старых
 * снапшотов и recovery-путей. Для НОВОГО торгового рантайма владелец
 * обязателен: без него нельзя ни проверить, что заявка принадлежит этому
 * аккаунту, ни запретить отмену чужой заявки.
 *
 * Сам `Order` этот MR не меняет: снятие `optional` затрагивает всех его
 * потребителей и является отдельным cleanup'ом домена. Приватное состояние
 * закрывает требование на своей границе.
 *
 * @example
 * ```typescript
 * throw new AccountOrderAccountMissingError(venueId, accountId, orderId);
 * ```
 */
export class AccountOrderAccountMissingError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param venueId - Площадка владельца
   * @param accountId - Аккаунт владельца
   * @param orderId - Заявка без `accountId`
   */
  constructor(
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    public readonly orderId: OrderId,
  ) {
    super(
      `Order ${orderId} has no accountId; the new trading runtime requires an owner ` +
        `(account ${describeAccount(venueId, accountId)})`,
      { context: { ...accountContext(venueId, accountId), orderId } },
    );
  }
}

/**
 * Тот же `OrderId` пришёл с другой неизменяемой идентичностью.
 *
 * @remarks
 * `status`, исполнения и `reason` меняться обязаны — на то это и post-commit
 * заявка. А вот инструмент, сторона, цена, объём, момент создания, владелец и
 * автор при том же идентификаторе означают ДРУГУЮ заявку: либо коллизия
 * идентификаторов, либо ошибка producer'а. Применить её значило бы подменить
 * сохранённое обязательство чужим, сохранив его историю исполнений.
 *
 * @example
 * ```typescript
 * throw new AccountOrderIdentityConflictError(venueId, accountId, orderId, {
 *   field: 'size', stored: '100', incoming: '150',
 * });
 * ```
 */
export class AccountOrderIdentityConflictError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param venueId - Площадка владельца
   * @param accountId - Аккаунт владельца
   * @param orderId - Заявка, по которой конфликт
   * @param difference - Первое найденное расхождение идентичности
   */
  constructor(
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    public readonly orderId: OrderId,
    public readonly difference: AccountOrderIdentityDifference,
  ) {
    super(
      `Order ${orderId} identity conflict on ${difference.field} for trading account ` +
        `${describeAccount(venueId, accountId)}: stored ${difference.stored}, ` +
        `incoming ${difference.incoming}`,
      {
        context: {
          ...accountContext(venueId, accountId),
          orderId,
          field: difference.field,
          stored: difference.stored,
          incoming: difference.incoming,
        },
      },
    );
  }
}

/** Что именно не удалось привести к торговому инструменту. */
export type AccountInstrumentSubject = 'ORDER_ASSET' | 'FILL_TOKEN';

/**
 * Актив не приводится к `InstrumentId`.
 *
 * @remarks
 * Вторичные индексы приватного состояния ключуются `InstrumentId`, потому что
 * именно им адресуется рынок в торговом состоянии. Актив, который в
 * `InstrumentId` не превращается, нельзя связать с рыночным контекстом: по
 * такой заявке нельзя ни найти стакан, ни оценить позицию.
 *
 * Отказ приходит ДО мутации: заявка, которую невозможно связать с рынком, не
 * должна попадать в состояние «на всякий случай» — она бы там осталась
 * невидимой для любого навигационного запроса.
 *
 * @example
 * ```typescript
 * throw new AccountInstrumentResolutionError('ORDER_ASSET', venueId, accountId, 'CURRENCY:USDC');
 * ```
 */
export class AccountInstrumentResolutionError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param subject - Заявка или исполнение
   * @param venueId - Площадка владельца
   * @param accountId - Аккаунт владельца
   * @param asset - Актив, который не удалось привести (canonical строка)
   */
  constructor(
    public readonly subject: AccountInstrumentSubject,
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    public readonly asset: string,
  ) {
    super(
      `Asset ${asset} (${subject}) does not resolve to an InstrumentId for trading ` +
        `account ${describeAccount(venueId, accountId)}`,
      { context: { ...accountContext(venueId, accountId), subject, asset } },
    );
  }
}

/** Поле связи, по которому заявка и исполнение разошлись. */
export type AccountFillOrderLinkField = 'orderId' | 'asset';

/**
 * Заявка и исполнение в одном событии описывают разные вещи.
 *
 * @remarks
 * `TRADING_ACCOUNT_FILL_APPLIED`/`REVERTED` могут нести post-commit заявку
 * ВМЕСТЕ с исполнением. Тогда они обязаны быть связаны:
 *
 * ```text
 * order.id     === fill.orderId
 * order.asset  === fill.tokenId
 * ```
 *
 * (Владелец проверяется отдельно — {@link AccountIdentityMismatchError} с
 * `subject = 'FILL_ORDER_ACCOUNT'`.)
 *
 * Расхождение означает, что одно событие пытается атомарно применить два
 * несвязанных факта. Применить его частично нельзя — в этом и состоит смысл
 * атомарности, — поэтому отвергается всё событие целиком.
 *
 * @example
 * ```typescript
 * throw new AccountFillOrderLinkError('orderId', venueId, accountId, fillId, 'order-1', 'order-2');
 * ```
 */
export class AccountFillOrderLinkError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param field - Поле связи, по которому найдено расхождение
   * @param venueId - Площадка владельца
   * @param accountId - Аккаунт владельца
   * @param fillId - Исполнение из события
   * @param inFill - Значение в исполнении
   * @param inOrder - Значение в заявке
   */
  constructor(
    public readonly field: AccountFillOrderLinkField,
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    public readonly fillId: FillId,
    public readonly inFill: string,
    public readonly inOrder: string,
  ) {
    super(
      `Fill ${fillId} and the order in the same event disagree on ${field} for trading ` +
        `account ${describeAccount(venueId, accountId)}: fill has ${inFill}, order has ${inOrder}`,
      {
        context: { ...accountContext(venueId, accountId), field, fillId, inFill, inOrder },
      },
    );
  }
}

/** Событие, при обработке которого обнаружен конфликт факта исполнения. */
export type AccountFillAction = 'APPLY' | 'CONFIRM' | 'REVERT';

/**
 * Тот же `FillId` пришёл с другим фактом сделки.
 *
 * @remarks
 * У `Fill` нет изменяемой части: цена, размер, сторона, комиссия и момент
 * исполнения зафиксированы навсегда. Другое значение любого из них при том же
 * идентификаторе — это другое исполнение, а не уточнение старого.
 *
 * Особенно важно для `CONFIRM`: подтверждение относится к КОНКРЕТНОМУ факту,
 * и подтвердить «исполнение №7» без сверки полей значило бы объявить
 * финальной сделку, которой не было.
 *
 * @example
 * ```typescript
 * throw new AccountFillIdentityConflictError(venueId, accountId, fillId, 'CONFIRM', {
 *   field: 'price', stored: '0.65', incoming: '0.66',
 * });
 * ```
 */
export class AccountFillIdentityConflictError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param venueId - Площадка владельца
   * @param accountId - Аккаунт владельца
   * @param fillId - Исполнение, по которому конфликт
   * @param action - Событие, при обработке которого найден конфликт
   * @param difference - Первое найденное расхождение факта
   */
  constructor(
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    public readonly fillId: FillId,
    public readonly action: AccountFillAction,
    public readonly difference: AccountFillFactDifference,
  ) {
    super(
      `Fill ${fillId} identity conflict on ${difference.field} during ${action} for trading ` +
        `account ${describeAccount(venueId, accountId)}: stored ${difference.stored}, ` +
        `incoming ${difference.incoming}`,
      {
        context: {
          ...accountContext(venueId, accountId),
          fillId,
          action,
          field: difference.field,
          stored: difference.stored,
          incoming: difference.incoming,
        },
      },
    );
  }
}

/**
 * Подтверждение или откат пришли по неизвестному исполнению.
 *
 * @remarks
 * Состояние НЕ создаёт исполнение по `CONFIRM`/`REVERT`: экономический эффект
 * пропущенной сделки пришлось бы угадать, а угаданные деньги — это неверные
 * деньги.
 *
 * Правильный порядок восстановления пропущенного исполнения:
 *
 * ```text
 * TRADING_ACCOUNT_FILL_APPLIED    ← вместе с посчитанным Portfolio
 * TRADING_ACCOUNT_FILL_CONFIRMED  ← только потом, при наличии финальности
 * ```
 *
 * За это отвечает будущий reconciler, а не проекция.
 *
 * @example
 * ```typescript
 * throw new AccountFillNotFoundError(venueId, accountId, fillId, 'CONFIRM');
 * ```
 */
export class AccountFillNotFoundError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param venueId - Площадка владельца
   * @param accountId - Аккаунт владельца
   * @param fillId - Исполнение, которого состояние не знает
   * @param action - Событие, которое пришло по этому исполнению
   */
  constructor(
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    public readonly fillId: FillId,
    public readonly action: AccountFillAction,
  ) {
    super(
      `Fill ${fillId} is unknown to trading account ${describeAccount(venueId, accountId)}; ` +
        `${action} rejected — a missed fill must be materialized by FILL_APPLIED first`,
      { context: { ...accountContext(venueId, accountId), fillId, action } },
    );
  }
}

/**
 * Переход runtime-статуса исполнения запрещён.
 *
 * @remarks
 * Разрешены ровно два перехода:
 *
 * ```text
 * APPLIED → CONFIRMED
 * APPLIED → REVERTED
 * ```
 *
 * `CONFIRMED → REVERTED` запрещён сознательно: `CONFIRMED` означает
 * финальность. Если площадка когда-нибудь отменит финализированное
 * исполнение, это будет отдельный явный recovery-контракт с собственным
 * событием и собственными проверками — а не тихий переход, встроенный «на
 * всякий случай» и способный откатить деньги, которые считались
 * окончательными.
 *
 * `REVERTED → CONFIRMED` запрещён по той же логике: подтверждать откаченное
 * исполнение нечего.
 *
 * @example
 * ```typescript
 * throw new AccountFillTransitionError(venueId, accountId, fillId, 'CONFIRMED', 'REVERTED');
 * ```
 */
export class AccountFillTransitionError extends TradingError {
  public readonly severity = 'critical' as const;

  /**
   * @param venueId - Площадка владельца
   * @param accountId - Аккаунт владельца
   * @param fillId - Исполнение, по которому пришёл переход
   * @param current - Текущий runtime-статус
   * @param target - Статус, в который просили перейти
   */
  constructor(
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    public readonly fillId: FillId,
    public readonly current: AccountFillStatus,
    public readonly target: AccountFillStatus,
  ) {
    super(
      `Fill ${fillId} cannot transition ${current} → ${target} for trading account ` +
        `${describeAccount(venueId, accountId)}`,
      { context: { ...accountContext(venueId, accountId), fillId, current, target } },
    );
  }
}

/** Любой отказ приватного состояния аккаунта. */
export type AccountStateError =
  | AccountAlreadyInitializedError
  | AccountNotInitializedError
  | AccountIdentityMismatchError
  | AccountPortfolioIdentityMismatchError
  | AccountOrderAccountMissingError
  | AccountOrderIdentityConflictError
  | AccountInstrumentResolutionError
  | AccountFillOrderLinkError
  | AccountFillIdentityConflictError
  | AccountFillNotFoundError
  | AccountFillTransitionError;

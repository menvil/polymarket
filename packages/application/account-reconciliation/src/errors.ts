/**
 * Отказы authoritative-сверки аккаунта.
 *
 * @remarks
 * Каждый класс несёт literal-поле `failureCode` — по нему health сверки
 * запоминает ВИД отказа, а вызывающий различает ошибки, не разбирая текст
 * сообщения:
 *
 * ```text
 * SOURCE_FAILED      обязательное чтение источника не удалось
 * UNRESOLVED_ORDER   локально открытая заявка источнику неизвестна
 * VALIDATION_FAILED  снимок нельзя применить: аккаунт не принят, источник
 *                    противоречит себе, canonical-путь отверг коррекцию
 * PUBLISH_FAILED     шина не приняла событие коррекции
 * ```
 *
 * Все четыре переводят health аккаунта в `UNHEALTHY`: снимок либо не получен,
 * либо не применён, и локальное состояние не подтверждено.
 *
 * ### Конфликт версий — НЕ здесь
 *
 * `AccountReconciliationVersionConflictError` принадлежит `@polymarket/
 * account-state`: CAS проверяет состояние, а не сверка. И это не отказ, а
 * нормальная гонка — health он в `UNHEALTHY` не переводит, а координатор
 * отвечает на него свежим проходом. Распознаётся по классу (`instanceof`).
 */
import { TradingError } from '@polymarket/errors';
import {
  accountIdToString,
  type AccountId,
  type OrderId,
  type VenueId,
} from '@polymarket/ids';
import type { AccountReconciliationVersionConflictError } from '@polymarket/account-state';

/** Контекст ошибки: пара, адресующая аккаунт. */
function accountContext(venueId: VenueId, accountId: AccountId) {
  return { venueId, accountId: accountIdToString(accountId) };
}

/** Читаемая пара «площадка/аккаунт» для текста ошибки. */
function describeAccount(venueId: VenueId, accountId: AccountId): string {
  return `${venueId}/${accountIdToString(accountId)}`;
}

/** Вид отказа сверки — то, что запоминает health. */
export type AccountReconciliationFailureCode =
  | 'SOURCE_FAILED'
  | 'UNRESOLVED_ORDER'
  | 'VALIDATION_FAILED'
  | 'PUBLISH_FAILED';

/** Чтение источника, которое не удалось. */
export type AccountReconciliationSourceOperation =
  | 'getPortfolio'
  | 'getOpenOrders'
  | 'getFills'
  | 'getOrder';

/**
 * Обязательное чтение authoritative-источника не удалось.
 *
 * @remarks
 * Создаётся адаптером источника на его границе — сеть, авторизация, rate
 * limit, ответ, который нельзя перевести в canonical-сущность, — либо самой
 * сверкой, если адаптер нарушил контракт порта и бросил исключение вместо
 * `Err`.
 *
 * Снимок, у которого не удалось хотя бы одно обязательное чтение, неполон, и
 * коррекция по нему НЕ публикуется: частично полученный снимок исправил бы
 * одно и молча оставил бы расходиться другое.
 *
 * @example
 * ```typescript
 * return Err(new AccountReconciliationSourceError('getFills', venueId, accountId, 'HTTP 503'));
 * ```
 */
export class AccountReconciliationSourceError extends TradingError {
  public readonly severity = 'high' as const;
  /** {@inheritDoc AccountReconciliationFailureCode} */
  public readonly failureCode = 'SOURCE_FAILED' as const;
  /** Заявка, на которой не удался `getOrder`; для остальных чтений — `undefined` */
  public readonly orderId: OrderId | undefined;
  /** Исходная ошибка транспорта или адаптера, если она есть */
  public readonly originalError: unknown;

  /**
   * @param operation - Какое чтение не удалось
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @param detail - Что именно пошло не так (для лога)
   * @param options - Необязательные подробности
   * @param options.orderId - Заявка, если не удался `getOrder`
   * @param options.originalError - Исходная ошибка транспорта или адаптера
   */
  constructor(
    public readonly operation: AccountReconciliationSourceOperation,
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    detail: string,
    options: { readonly orderId?: OrderId; readonly originalError?: unknown } = {},
  ) {
    super(
      `Account reconciliation source ${operation} failed for ${describeAccount(venueId, accountId)}` +
        `${options.orderId === undefined ? '' : ` (order ${options.orderId})`}: ${detail}`,
      {
        context: {
          ...accountContext(venueId, accountId),
          operation,
          detail,
          ...(options.orderId === undefined ? {} : { orderId: options.orderId }),
          ...(options.originalError === undefined ? {} : { originalError: options.originalError }),
        },
      },
    );
    this.orderId = options.orderId;
    this.originalError = options.originalError;
  }
}

/**
 * Локально открытая заявка неизвестна authoritative-источнику.
 *
 * @remarks
 * Сценарий:
 *
 * ```text
 * локально:       order-123 OPEN
 * getOpenOrders:  order-123 нет
 * getOrder(123):  undefined
 * ```
 *
 * Что стало с заявкой — отменена, исполнена, отвергнута, истекла или
 * источник временно её не вернул, — из этого вывести НЕЛЬЗЯ. Угаданный
 * статус освободил бы или оставил резервацию наугад, то есть неверные деньги.
 * Поэтому коррекция не публикуется (fail closed), а health уходит в
 * `UNHEALTHY`.
 *
 * Сюда же попадает `PENDING`-заявка, ещё не дошедшая до площадки: для
 * рантайма это уже принятое обязательство (`OPEN_ORDER_STATUSES`), а для
 * площадки — неизвестный идентификатор. Отличить «ещё летит» от «потеряна»
 * по одному снимку нельзя.
 *
 * @example
 * ```typescript
 * throw new AccountReconciliationUnresolvedOrderError(venueId, accountId, ['order-123']);
 * ```
 */
export class AccountReconciliationUnresolvedOrderError extends TradingError {
  public readonly severity = 'high' as const;
  /** {@inheritDoc AccountReconciliationFailureCode} */
  public readonly failureCode = 'UNRESOLVED_ORDER' as const;

  /**
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @param orderIds - Все локально открытые заявки, которых источник не знает
   */
  constructor(
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    public readonly orderIds: readonly OrderId[],
  ) {
    super(
      `Account reconciliation for ${describeAccount(venueId, accountId)} cannot resolve ` +
        `locally open order(s) unknown to the authoritative source: ${orderIds.join(', ')}`,
      { context: { ...accountContext(venueId, accountId), orderIds: [...orderIds] } },
    );
  }
}

/**
 * Почему снимок нельзя применить.
 *
 * @remarks
 * - `ACCOUNT_NOT_INITIALIZED` — аккаунт не принят приватным состоянием.
 *   Сверка корректирует существующий аккаунт и не создаёт его: без принятого
 *   аккаунта нет ни версии для CAS, ни владельца для записей.
 * - `ORDER_ID_MISMATCH` — на `getOrder(X)` источник вернул заявку с другим
 *   идентификатором: ответ противоречит вопросу, и доверять ему нельзя.
 * - `CORRECTION_REJECTED` — canonical-путь отверг коррекцию: critical-
 *   подписчик `TRADING_ACCOUNT_RECONCILED` (сегодня единственный —
 *   `AccountStateProjector`) нашёл снимок несогласованным. Исходная ошибка
 *   состояния — в `originalError`.
 */
export type AccountReconciliationValidationReason =
  | 'ACCOUNT_NOT_INITIALIZED'
  | 'ORDER_ID_MISMATCH'
  | 'CORRECTION_REJECTED';

/**
 * Снимок получен, но применить его нельзя.
 *
 * @remarks
 * Проверки согласованности самого снимка — владелец, инструмент,
 * идентичность, переходы — живут в `AccountHotState`, а не здесь: второе
 * место, где решается «валиден ли снимок», неизбежно разошлось бы с первым.
 * Сверка проверяет только то, без чего не может собрать снимок, и передаёт
 * отказ состояния наверх как `CORRECTION_REJECTED`.
 *
 * @example
 * ```typescript
 * throw new AccountReconciliationValidationError(
 *   'CORRECTION_REJECTED', venueId, accountId, 'order identity conflict', stateError,
 * );
 * ```
 */
export class AccountReconciliationValidationError extends TradingError {
  public readonly severity = 'critical' as const;
  /** {@inheritDoc AccountReconciliationFailureCode} */
  public readonly failureCode = 'VALIDATION_FAILED' as const;

  /**
   * @param reason - Почему снимок нельзя применить
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @param detail - Подробности для лога
   * @param originalError - Исходная ошибка (для `CORRECTION_REJECTED` — ошибка состояния)
   */
  constructor(
    public readonly reason: AccountReconciliationValidationReason,
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    detail: string,
    public readonly originalError?: unknown,
  ) {
    super(
      `Account reconciliation for ${describeAccount(venueId, accountId)} failed validation ` +
        `(${reason}): ${detail}`,
      {
        context: {
          ...accountContext(venueId, accountId),
          reason,
          detail,
          ...(originalError === undefined ? {} : { originalError }),
        },
      },
    );
  }
}

/**
 * Шина не приняла событие коррекции.
 *
 * @remarks
 * Переполнение очереди или лимит drain-цикла (`QueueOverflowError`), а также
 * непредвиденное исключение при сборке metadata или публикации. Снимок
 * получен и, возможно, верен, но в состояние не попал — health это обязан
 * показывать.
 *
 * @example
 * ```typescript
 * throw new AccountReconciliationPublishError(venueId, accountId, overflowError);
 * ```
 */
export class AccountReconciliationPublishError extends TradingError {
  public readonly severity = 'high' as const;
  /** {@inheritDoc AccountReconciliationFailureCode} */
  public readonly failureCode = 'PUBLISH_FAILED' as const;

  /**
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @param originalError - Ошибка шины или исключение публикации
   */
  constructor(
    public readonly venueId: VenueId,
    public readonly accountId: AccountId,
    public readonly originalError: unknown,
  ) {
    super(
      `Account reconciliation event for ${describeAccount(venueId, accountId)} was not ` +
        `accepted by the event bus: ${describeUnknown(originalError)}`,
      { context: { ...accountContext(venueId, accountId), originalError } },
    );
  }
}

/**
 * Отказ сверки, переводящий health в `UNHEALTHY`.
 *
 * @remarks
 * Конфликт версий сюда НЕ входит: это нормальная гонка, а не отказ.
 */
export type AccountReconciliationFailure =
  | AccountReconciliationSourceError
  | AccountReconciliationUnresolvedOrderError
  | AccountReconciliationValidationError
  | AccountReconciliationPublishError;

/**
 * Любой неуспешный исход одного прохода сверки.
 *
 * @remarks
 * Конфликт версий отличается от остальных ПО КЛАССУ: координатор проверяет
 * `instanceof AccountReconciliationVersionConflictError` и не трогает health.
 */
export type AccountReconciliationError =
  | AccountReconciliationFailure
  | AccountReconciliationVersionConflictError;

/**
 * Читаемое описание произвольного брошенного значения.
 *
 * @param value - Что угодно, что могло быть брошено
 * @returns Сообщение ошибки либо строковое представление
 */
function describeUnknown(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

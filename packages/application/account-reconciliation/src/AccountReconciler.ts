/**
 * Один проход authoritative-сверки аккаунта.
 *
 * @remarks
 * ```text
 * reconcile(venueId, accountId)
 *         ↓
 * прочитать локальный аккаунт: version → expectedAccountVersion,
 *                              локально открытые заявки
 *         ↓
 * source.getPortfolio ┐
 * source.getOpenOrders├ параллельно; любой отказ → Err, события НЕТ
 * source.getFills     ┘
 *         ↓
 * локально открытые, которых нет среди открытых у источника
 *         → source.getOrder(orderId) для каждой
 *           найдена   → её настоящее состояние идёт в снимок
 *           undefined → Err(UnresolvedOrder), события НЕТ
 *         ↓
 * TRADING_ACCOUNT_RECONCILED(expectedAccountVersion, portfolio, orders, fills)
 *         ↓
 * IEventBus → AccountStateProjector → AccountHotState
 * ```
 *
 * ### Почему reconciler не пишет в состояние
 *
 * Единственный писатель `AccountHotState` — `AccountStateProjector`. Сверка
 * получает только read-only `AccountHotStateView` и публикует canonical-
 * событие в ту же шину, что и живой контур. Третьей шины, отдельного
 * reconciliation bus и прямой мутации нет: иначе у состояния стало бы два
 * писателя, и порядок их эффектов не определялся бы ничем.
 *
 * ### Почему версия читается ДО запросов
 *
 * Снимок строится несколькими запросами к источнику, пока живой контур
 * продолжает менять аккаунт. Запомненная версия уходит в событие как
 * `expectedAccountVersion`, и состояние применит коррекцию, только если
 * аккаунт за это время не изменился (CAS). Заранее здесь конфликт не
 * проверяется: решение принимается в одном месте — там, где версия и
 * меняется.
 *
 * ### Почему отсутствие среди открытых требует `getOrder`
 *
 * «Заявки нет в списке открытых» не говорит, что с ней стало: отменена,
 * исполнена, отвергнута, истекла или источник временно её не вернул. Поэтому
 * её настоящее состояние спрашивается отдельно, а ответ «не знаю» не
 * интерпретируется вовсе — снимок неполон, и коррекция не публикуется.
 *
 * ### Валидация — не здесь
 *
 * Владелец, инструмент, идентичность и переходы проверяет `AccountHotState`
 * при применении события. Здесь — только то, без чего снимок не собрать:
 * существование аккаунта и то, что `getOrder(X)` вернул именно `X`.
 */
import type {
  TradingAccountReconciledEvent,
} from '@polymarket/application-events';
import {
  AccountReconciliationVersionConflictError,
  type AccountHotStateView,
} from '@polymarket/account-state';
import { CriticalHandlerError } from '@polymarket/errors/event-bus';
import type { IEventBus } from '@polymarket/event-bus';
import type { AccountId, OrderId, VenueId } from '@polymarket/ids';
import type { MessageMetadataGenerator } from '@polymarket/messages';
import type { Order } from '@polymarket/order';
import { Err, Ok, type Result } from '@polymarket/result';
import {
  AccountReconciliationPublishError,
  AccountReconciliationSourceError,
  AccountReconciliationUnresolvedOrderError,
  AccountReconciliationValidationError,
  type AccountReconciliationError,
  type AccountReconciliationSourceOperation,
} from './errors.js';
import type { IAccountReconciliationSource } from './IAccountReconciliationSource.js';

/**
 * Зависимости одного reconciler'а.
 *
 * @remarks
 * `accountState` — только view: мутирующего API у сверки нет по построению.
 */
export interface AccountReconcilerDependencies {
  /** Authoritative-источник состояния аккаунта */
  readonly source: IAccountReconciliationSource;
  /**
   * Canonical-шина — та же, по которой идут живые события аккаунта.
   *
   * @remarks
   * Коррекция публикуется через `publishConfirmed()`: сверка — внешняя
   * request/response-граница, и её исход обязан относиться к её событию.
   * Поэтому reconcile() нельзя вызывать с `await` из handler'а шины.
   */
  readonly eventBus: IEventBus;
  /** Read-only проекция приватного состояния */
  readonly accountState: AccountHotStateView;
  /**
   * Генератор canonical metadata рантайма.
   *
   * @remarks
   * `metadata.createdAt` события коррекции — момент её публикации, то есть
   * момент применения к локальному рантайму. Часы берутся из генератора, а
   * не из `Date.now()`.
   */
  readonly metadata: MessageMetadataGenerator;
}

/** Успешный проход: коррекция опубликована и принята canonical-путём. */
export interface AccountReconciliationPass {
  /**
   * Опубликованное событие коррекции.
   *
   * @remarks
   * Успех означает, что ИМЕННО это событие прошло critical-обработчики и
   * состояние приняло снимок — применив его одной мутацией либо признав
   * no-op. Различать эти случаи сверке не нужно: оба подтверждают, что
   * локальное состояние совпадает с источником. Гарантию даёт
   * `IEventBus.publishConfirmed()`, а не обычный `publish()`.
   */
  readonly event: TradingAccountReconciledEvent;
}

/** Исход одного прохода сверки. */
export type AccountReconciliationPassResult = Result<
  AccountReconciliationPass,
  AccountReconciliationError
>;

/**
 * Выполняет один проход authoritative-сверки аккаунта.
 *
 * @remarks
 * Не планирует проходы, не повторяет их и не ведёт health — этим владеет
 * {@link AccountReconciliationCoordinator}. Reconciler только строит снимок и
 * публикует коррекцию. Параллельный вызов для ОДНОГО аккаунта безопасен для
 * состояния (CAS отвергнет устаревший снимок), но расточителен — поэтому
 * рантайм вызывает сверку через координатор.
 *
 * @example
 * ```typescript
 * const reconciler = AccountReconciler.create({ source, eventBus, accountState, metadata });
 * const pass = await reconciler.reconcile(venueId, accountId);
 * if (!pass.ok && pass.error instanceof AccountReconciliationVersionConflictError) {
 *   // снимок устарел — нужен свежий проход, а не повтор этого
 * }
 * ```
 */
export class AccountReconciler {
  private constructor(private readonly _deps: AccountReconcilerDependencies) {}

  /**
   * Создаёт reconciler.
   *
   * @param deps - Источник, шина, read-only состояние и генератор metadata
   * @returns Готовый reconciler
   *
   * @example
   * ```typescript
   * const reconciler = AccountReconciler.create({ source, eventBus, accountState, metadata });
   * ```
   */
  public static create(deps: AccountReconcilerDependencies): AccountReconciler {
    return new AccountReconciler(deps);
  }

  /**
   * Выполняет один проход сверки аккаунта.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @returns `Ok` с опубликованным событием либо отказ прохода
   *
   * @remarks
   * Никогда не бросает: отказ источника, исключение адаптера или шины
   * возвращаются как `Err`. Исходы относятся к ЭТОМУ событию коррекции:
   *
   * ```text
   * Ok                 оно прошло critical-обработчики; состояние приняло
   *                    коррекцию или no-op
   * Err(VersionConflict) именно оно получило CAS-конфликт
   * Err(Validation)    именно оно отвергнуто состоянием (CORRECTION_REJECTED)
   *                    либо снимок не собран (аккаунт не принят, ответ getOrder
   *                    противоречит вопросу) — тогда события нет
   * Err(Source / UnresolvedOrder) снимок не получен — события нет
   * Err(Publish)       событие не подтверждено: шина его не приняла либо упал
   *                    уже стоявший backlog, и событие в очередь не попало
   * ```
   *
   * Применение этого события после `Err` невозможно: `publishConfirmed()` не
   * ставит его в очередь, если backlog упал, а в собственном drain событие
   * обрабатывается первым.
   *
   * @example
   * ```typescript
   * const pass = await reconciler.reconcile(venueId, accountId);
   * ```
   */
  public async reconcile(
    venueId: VenueId,
    accountId: AccountId,
  ): Promise<AccountReconciliationPassResult> {
    // Версия и локально открытые заявки читаются ОДНИМ синхронным участком:
    // между ними не может вклиниться живое событие, и оба значения описывают
    // одно и то же состояние аккаунта.
    const account = this._deps.accountState.getAccount(venueId, accountId);
    if (account === undefined) {
      return Err(
        new AccountReconciliationValidationError(
          'ACCOUNT_NOT_INITIALIZED',
          venueId,
          accountId,
          'account is not initialized in the private account state',
        ),
      );
    }
    const expectedAccountVersion = account.version;
    const localOpenOrderIds = account.openOrders().map((record) => record.order.id);

    const { source } = this._deps;
    const [portfolio, openOrders, fills] = await Promise.all([
      guardSource('getPortfolio', venueId, accountId, () => source.getPortfolio(venueId, accountId)),
      guardSource('getOpenOrders', venueId, accountId, () => source.getOpenOrders(venueId, accountId)),
      guardSource('getFills', venueId, accountId, () => source.getFills(venueId, accountId)),
    ]);
    if (!portfolio.ok) return portfolio;
    if (!openOrders.ok) return openOrders;
    if (!fills.ok) return fills;

    const orders = await this._resolveOrders(
      venueId,
      accountId,
      localOpenOrderIds,
      openOrders.value,
    );
    if (!orders.ok) return orders;

    return this._publish({
      venueId,
      accountId,
      expectedAccountVersion,
      portfolio: portfolio.value,
      orders: orders.value,
      fills: fills.value,
    });
  }

  /**
   * Собирает authoritative-состояние заявок снимка.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @param localOpenOrderIds - Заявки, открытые локально на момент чтения версии
   * @param openOrders - Заявки, открытые у источника
   * @returns Открытые заявки источника плюс настоящее состояние недостающих
   *
   * @remarks
   * «Открытая» локально — ровно `OPEN_ORDER_STATUSES` из `@polymarket/order`
   * (через `AccountRuntimeStateView.openOrders()`), без собственного списка
   * статусов: `PENDING` входит, потому что под него уже зарезервированы
   * деньги или токены.
   *
   * Все недостающие заявки спрашиваются параллельно. Отказ чтения и ответ,
   * противоречащий вопросу, возвращаются сразу; неизвестные источнику заявки
   * собираются все, чтобы отказ называл каждую.
   */
  private async _resolveOrders(
    venueId: VenueId,
    accountId: AccountId,
    localOpenOrderIds: readonly OrderId[],
    openOrders: readonly Order[],
  ): Promise<Result<readonly Order[], AccountReconciliationError>> {
    const authoritativeOpen = new Set<OrderId>(openOrders.map((order) => order.id));
    const missing = localOpenOrderIds.filter((orderId) => !authoritativeOpen.has(orderId));
    if (missing.length === 0) return Ok(openOrders);

    const { source } = this._deps;
    const answers = await Promise.all(
      missing.map((orderId) =>
        guardSource(
          'getOrder',
          venueId,
          accountId,
          () => source.getOrder(venueId, accountId, orderId),
          orderId,
        ),
      ),
    );

    const resolved: Order[] = [...openOrders];
    const unresolved: OrderId[] = [];
    for (const [index, answer] of answers.entries()) {
      const orderId = missing[index];
      if (!answer.ok) return answer;

      const order = answer.value;
      if (order === undefined) {
        // Не угадываем: «источник не знает» не означает ни отмены, ни
        // исполнения.
        unresolved.push(orderId);
        continue;
      }
      if (order.id !== orderId) {
        return Err(
          new AccountReconciliationValidationError(
            'ORDER_ID_MISMATCH',
            venueId,
            accountId,
            `getOrder(${orderId}) returned order ${order.id}`,
          ),
        );
      }
      resolved.push(order);
    }

    if (unresolved.length > 0) {
      return Err(new AccountReconciliationUnresolvedOrderError(venueId, accountId, unresolved));
    }
    return Ok(resolved);
  }

  /**
   * Публикует коррекцию и переводит исход шины в исход прохода.
   *
   * @param payload - Полный снимок и версия, на которой он основан
   * @returns Проход либо отказ
   *
   * @remarks
   * Публикация — `IEventBus.publishConfirmed()`, а не `publish()`: обычный
   * `publish()` при уже активном drain подтверждает только постановку в
   * очередь, и `Ok` прохода не означал бы, что коррекция применена.
   * `publishConfirmed()` дожидается существующего backlog, ставит событие
   * первым в новый drain и возвращает исход ИМЕННО его обработки.
   *
   * Подписка проектора critical, поэтому отказ состояния приходит сюда как
   * `CriticalHandlerError` с исходной ошибкой в `context.originalError`:
   *
   * ```text
   * НАШЕ событие, originalError — VersionConflict → вернуть его как есть (гонка)
   * НАШЕ событие, любая другая ошибка              → CORRECTION_REJECTED
   * critical-ошибка на ДРУГОМ событии drain'а      → PUBLISH_FAILED
   * QueueOverflowError / исключение               → PUBLISH_FAILED
   * ```
   *
   * «Наше» определяется по `context.messageId`, а не по типу события:
   * координатор сверяет разные аккаунты параллельно, и `publishConfirmed()`
   * возвращает отказ уже стоявшего backlog — например, коррекции другого
   * аккаунта. По одному `TRADING_ACCOUNT_RECONCILED` мы приняли бы чужой
   * конфликт или отказ за свой. Чужой отказ означает, что наше событие не
   * публиковалось, поэтому он — `PUBLISH_FAILED`, а не диагноз нашего
   * снимка.
   *
   * Конфликт распознаётся по классу, а не по тексту.
   */
  private async _publish(
    payload: TradingAccountReconciledEvent['payload'],
  ): Promise<AccountReconciliationPassResult> {
    const { venueId, accountId } = payload;

    let event: TradingAccountReconciledEvent;
    let published: Awaited<ReturnType<IEventBus['publishConfirmed']>>;
    try {
      event = {
        type: 'TRADING_ACCOUNT_RECONCILED',
        payload,
        metadata: this._deps.metadata.nextRoot(),
      };
      published = await this._deps.eventBus.publishConfirmed(event);
    } catch (error) {
      return Err(new AccountReconciliationPublishError(venueId, accountId, error));
    }

    if (published.ok) return Ok({ event });

    const failure = published.error;
    if (
      failure instanceof CriticalHandlerError &&
      failure.context?.['eventType'] === event.type &&
      failure.context['messageId'] === event.metadata.messageId
    ) {
      const original = failure.context['originalError'];
      if (original instanceof AccountReconciliationVersionConflictError) return Err(original);
      return Err(
        new AccountReconciliationValidationError(
          'CORRECTION_REJECTED',
          venueId,
          accountId,
          original instanceof Error ? original.message : String(original),
          original,
        ),
      );
    }

    return Err(new AccountReconciliationPublishError(venueId, accountId, failure));
  }
}

/**
 * Вызывает чтение источника, превращая нарушение контракта порта в `Err`.
 *
 * @param operation - Какое чтение выполняется
 * @param venueId - Площадка аккаунта
 * @param accountId - Аккаунт
 * @param read - Само чтение
 * @param orderId - Заявка для `getOrder`
 * @returns Результат чтения либо `Err`, если адаптер бросил исключение
 *
 * @remarks
 * Порт обещает `Result`, но адаптер может нарушить обещание — бросить или
 * отвергнуть promise. Такое чтение считается неудавшимся (fail closed): снимок
 * без него неполон, а исключение, выпущенное наружу, сорвало бы координатору
 * его single-flight.
 */
async function guardSource<T>(
  operation: AccountReconciliationSourceOperation,
  venueId: VenueId,
  accountId: AccountId,
  read: () => Promise<Result<T, AccountReconciliationSourceError>>,
  orderId?: OrderId,
): Promise<Result<T, AccountReconciliationSourceError>> {
  try {
    return await read();
  } catch (error) {
    return Err(
      new AccountReconciliationSourceError(
        operation,
        venueId,
        accountId,
        `source threw instead of returning Err: ${error instanceof Error ? error.message : String(error)}`,
        { ...(orderId === undefined ? {} : { orderId }), originalError: error },
      ),
    );
  }
}

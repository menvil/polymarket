/**
 * UpdateOrderStatusUseCase — применяет venue-обновление статуса к Order entity.
 *
 * @remarks
 * Содержит всю доменную логику, ранее находившуюся в `OrderUpdateHandler`.
 * Тонкий `OrderUpdateHandler` теперь только парсит WS и публикует
 * `ORDER_UPDATE_RECEIVED`; `OrderUpdateOrchestrator` вызывает этот use case.
 *
 * ### Алгоритм:
 * 0. Взять keyed mutex по [accountId, orderId] — сериализует с PlaceOrderUseCase
 *    (пересечение по accountId), закрывая race «ранний terminal ORDER_UPDATE до
 *    локального save». Если Order всё ещё не найден под lock и update терминален
 *    (CANCELLED/REJECTED/EXPIRED) — создаётся `VENUE_LOCAL_ORDER_DESYNC` issue
 *    (`EARLY_ORDER_UPDATE_WITHOUT_LOCAL_ORDER`), возвращается Ok (без retry-loop).
 * 1. Атомарно прочитать Order + версию (getWithVersion) из репозитория
 * 2. Применить доменный метод (accept/reject/cancel/expire)
 * 3. Обработать idempotent/race сценарии
 * 4. CAS-сохранение обновлённого Order (save(order, expectedVersion))
 * 5. Для CANCELLED/EXPIRED/REJECTED — освободить резервацию Portfolio (только
 *    после успешного CAS save). Сбой release → error-лог +
 *    `ORDER_PORTFOLIO_DESYNC` reconciliation issue (best-effort), результат
 *    остаётся Ok — update уже committed
 * 6. Опубликовать OrderEvent[] в EventBus — notification path, НЕ часть
 *    транзакции: сбой publish после успешного CAS save логируется как
 *    `EVENT_PUBLISH_FAILED` и НЕ меняет результат (Ok) — committed update
 *    не должен становиться retryable из-за потери уведомления
 *
 * ### Защита от concurrent fill (CAS):
 * Между чтением версии и save мог выполниться ProcessFillUseCase и перезаписать
 * Order статус (FILLED) через saveSync — тогда версия выросла и CAS save вернёт
 * VersionConflictError. При конфликте перечитываем актуальное состояние:
 * если ордер терминален / уже в целевом статусе / исчез — идемпотентный no-op
 * (Ok, БЕЗ release/publish); иначе Err. Резервация освобождается только после
 * успешного CAS save — значит fill её потребить не успел.
 *
 * @example
 * ```typescript
 * const useCase = new UpdateOrderStatusUseCase({
 *   orderRepo, orderStateStore, portfolioService, eventBus, logger,
 * });
 * const result = await useCase.execute({
 *   update: { type: 'CANCELLED', orderId },
 *   accountId,
 * });
 * ```
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import { assetIdToInstrumentId, accountIdToString } from '@polymarket/ids';
import type { AccountId, OrderId } from '@polymarket/ids';
import type {
  IOrderRepository,
  IOrderStateStore,
  IKeyedMutex,
  IReconciliationIssueRepository,
  ReconciliationIssue,
} from '@polymarket/ports';
import type { IEventBus, ApplicationEvent, VenueOrderUpdate } from '@polymarket/event-bus';
import type { PortfolioService } from './services/PortfolioService.js';

/** Входные данные для UpdateOrderStatusUseCase */
export interface UpdateOrderStatusInput {
  /** Venue-обновление статуса с типом и orderId */
  readonly update: VenueOrderUpdate;
  /** ID аккаунта — нужен для операций с Portfolio */
  readonly accountId: AccountId;
}

/** Зависимости UpdateOrderStatusUseCase */
export interface UpdateOrderStatusDeps {
  readonly orderRepo: IOrderRepository;
  readonly orderStateStore: IOrderStateStore;
  readonly portfolioService: PortfolioService;
  /**
   * Keyed mutex — сериализует обработку update относительно PlaceOrderUseCase
   * (и ProcessFillUseCase/CancelOrderUseCase) по [accountId, orderId].
   *
   * @remarks
   * Закрывает race «ранний ORDER_UPDATE до локального save»: venue мог прислать
   * CANCELLED/REJECTED/EXPIRED раньше, чем PlaceOrderUseCase успел сохранить
   * Order после submitOrder(). Все use-case'ы держат `accountId` в lock-ключах,
   * поэтому update ждёт завершения конкурентного Place для того же аккаунта и
   * видит уже сохранённый Order вместо тихого сброса.
   */
  readonly keyedMutex: IKeyedMutex;
  readonly eventBus: IEventBus;
  readonly logger: ILogger;
  /**
   * Queryable хранилище reconciliation issues (опционально).
   *
   * @remarks
   * Optional — чтобы не ломать существующие конструкторы/тесты: без него
   * поведение прежнее (только logging). Если передан, сбой release резервации
   * ПОСЛЕ успешного CAS save (ордер уже terminal, резервация может остаться
   * замороженной) создаёт `ORDER_PORTFOLIO_DESYNC` issue. Сбой `add()`
   * логируется и НЕ меняет результат use case.
   */
  readonly reconciliationIssues?: IReconciliationIssueRepository;
  /**
   * Источник времени для `ReconciliationIssue.createdAt` (опционально).
   *
   * @remarks
   * Optional по той же причине. Без него используется `new Date()`.
   */
  readonly clock?: IClock;
}

/**
 * Use case применения venue-обновления статуса ордера.
 *
 * @remarks
 * Вызывается `OrderUpdateOrchestrator` при подписке на `ORDER_UPDATE_RECEIVED`
 * или напрямую из reconciler для синхронной обработки.
 */
export class UpdateOrderStatusUseCase {
  private readonly _logger: ILogger;

  /**
   * @param _deps - Зависимости use case
   */
  constructor(private readonly _deps: UpdateOrderStatusDeps) {
    this._logger = _deps.logger.child({ component: 'UpdateOrderStatusUseCase' });
  }

  /**
   * Best-effort создание reconciliation issue (release failure после CAS save).
   *
   * @param issue - Issue с детерминированным id (см. call site)
   *
   * @remarks
   * No-op, если `reconciliationIssues` не передан в deps. `add()` идемпотентен
   * по id. Ошибка `add()` логируется и проглатывается — issue не должен менять
   * результат use case (update уже committed → Ok).
   */
  private async _addReconciliationIssue(issue: ReconciliationIssue): Promise<void> {
    if (!this._deps.reconciliationIssues) {
      return;
    }
    try {
      await this._deps.reconciliationIssues.add(issue);
    } catch (err) {
      this._logger.error('Failed to add reconciliation issue', {
        issueId: issue.id,
        issueType: issue.type,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Применяет venue-обновление статуса к существующему ордеру.
   *
   * @param input - Входные данные с update и accountId
   * @returns Ok(void) при успехе или идемпотентном skip, Err при критических сбоях
   *
   * @remarks
   * Idempotent: дублирующие события (ACCEPTED на OPEN, CANCELLED на CANCELED) —
   * логируются на уровне debug/warn и возвращают Ok(void).
   */
  public async execute(input: UpdateOrderStatusInput): Promise<Result<void, TradingError>> {
    const { accountId } = input;
    const orderId: OrderId = input.update.orderId;

    // Keyed mutex по [accountId, orderId] — сериализует относительно
    // PlaceOrderUseCase (держит [accountId, instrumentId]; пересечение по
    // accountId) и ProcessFillUseCase/CancelOrderUseCase (держат accountId+orderId).
    // Закрывает race «ранний terminal ORDER_UPDATE до локального save Order».
    const lockKeys = [accountIdToString(accountId), String(orderId)];
    return this._deps.keyedMutex.runExclusive(lockKeys, () => this._executeLocked(input));
  }

  /**
   * Тело обработки update — вызывается ВНУТРИ keyed mutex.
   *
   * @param input - Входные данные с update и accountId
   * @returns Ok(void) при успехе/идемпотентном skip, Err при критических сбоях
   */
  private async _executeLocked(input: UpdateOrderStatusInput): Promise<Result<void, TradingError>> {
    const { update, accountId } = input;
    const orderId: OrderId = update.orderId;

    // Шаг 1: Получить Order + версию атомарно.
    // getWithVersion() гарантирует, что version относится к ТОЙ ЖЕ записи,
    // что и order — раздельные get()+getVersion() содержали yield-окно между
    // двумя await, где конкурирующая мутация могла бы рассинхронизировать
    // пару (не потеря данных — CAS save ниже всё равно поймал бы конфликт —
    // но лишний ложный конфликт под нагрузкой).
    const snapshot = await this._deps.orderRepo.getWithVersion(orderId);
    const order = snapshot?.order;
    const expectedVersion = snapshot?.version ?? 0;
    if (!order) {
      // Order по-прежнему не найден ДАЖЕ после ожидания lock. Для terminal
      // update-типов (CANCELLED/REJECTED/EXPIRED) это НЕ безопасный no-op:
      // venue сообщил о терминальном состоянии ордера, которого локально нет —
      // либо Place ещё не дошёл до save (и уже не дойдёт, раз мы под lock и его
      // не видим), либо ордер внешний. Тихий drop потерял бы факт terminal-события.
      // Создаём queryable issue и возвращаем Ok (update handler не должен
      // бесконечно retry-ить без локального order).
      const isTerminalUpdate =
        update.type === 'CANCELLED' || update.type === 'REJECTED' || update.type === 'EXPIRED';
      if (isTerminalUpdate) {
        this._logger.error('EARLY_ORDER_UPDATE_WITHOUT_LOCAL_ORDER: terminal venue update for order missing locally (even under lock)', {
          orderId: String(orderId),
          updateType: update.type,
        });
        await this._addReconciliationIssue({
          id: `reconciliation:order-update:${String(orderId)}:early-terminal-without-local-order`,
          type: 'VENUE_LOCAL_ORDER_DESYNC',
          status: 'OPEN',
          reason: `EARLY_ORDER_UPDATE_WITHOUT_LOCAL_ORDER: venue ${update.type} for order not found locally`,
          createdAt: this._deps.clock?.now() ?? new Date(),
          orderId,
          accountId,
          context: {
            stage: 'venue-update-order-not-found-under-lock',
            updateType: update.type,
          },
        });
      } else {
        // ACCEPTED без локального order — мягче: ордер обычно приходит через
        // ORDER_ACCEPTED сразу после Place, и его отсутствие здесь чаще
        // benign race (Place опубликует ACCEPTED сам). Только warning.
        this._logger.warn('Order not found for venue update (non-terminal) — ignoring', {
          orderId: String(orderId),
          updateType: update.type,
        });
      }
      return Ok(undefined);
    }

    // Шаг 2: Применить доменный метод
    let result;
    switch (update.type) {
      case 'ACCEPTED':
        result = order.accept();
        break;
      case 'REJECTED':
        result = order.reject(update.reason);
        break;
      case 'CANCELLED':
        result = order.cancel(update.reason);
        break;
      case 'EXPIRED':
        result = order.expire();
        break;
    }

    // Шаг 3: Обработать idempotent/race сценарии
    if (!result.ok) {
      const isIdempotent =
        (update.type === 'ACCEPTED'  && order.status === 'OPEN')    ||
        (update.type === 'CANCELLED' && order.status === 'CANCELED') ||
        (update.type === 'EXPIRED'   && order.status === 'EXPIRED');

      // ACCEPTED на терминальном ордере — гонка между REST-cancel и WS-confirmation.
      const isCancelRace = update.type === 'ACCEPTED' && order.isTerminal;

      if (isIdempotent) {
        this._logger.debug('Ignoring duplicate venue update (already in target state)', {
          orderId: String(orderId),
          updateType: update.type,
          currentStatus: order.status,
        });
        return Ok(undefined);
      } else if (isCancelRace) {
        this._logger.warn('ACCEPTED event arrived after order already terminal (cancel/fill race) — ignoring', {
          orderId: String(orderId),
          currentStatus: order.status,
          updateType: update.type,
        });
        return Ok(undefined);
      } else {
        this._logger.error('Failed to apply order update', {
          error: result.error.message,
          orderId: String(orderId),
          updateType: update.type,
        });
        return Err(new TradingError(
          `Failed to apply order update: ${result.error.message}`,
          { context: { orderId: String(orderId), updateType: update.type } },
        ));
      }
    }

    const updatedOrder = result.value;

    // Шаг 4: CAS-сохранение обновлённого Order.
    // Конфликт версии = конкурирующая мутация (например, fill через saveSync)
    // успела между чтением версии и записью — резервацию НЕ трогаем и события
    // НЕ публикуем, вместо этого перечитываем актуальное состояние.
    const events = updatedOrder.pullEvents();
    const saveResult = await this._deps.orderRepo.save(updatedOrder, expectedVersion);
    if (!saveResult.ok) {
      const latest = await this._deps.orderRepo.get(orderId);
      if (!latest || latest.status === updatedOrder.status || latest.isTerminal) {
        // Ордер исчез (cleanup), уже в целевом статусе (дубль-событие) или
        // терминален (конкурирующий fill/cancel обработал его первым) —
        // идемпотентный no-op; резервация обработана той мутацией.
        this._logger.warn('Order version conflict during venue update — latest state already settled, no-op', {
          orderId: String(orderId),
          updateType: update.type,
          latestStatus: latest?.status,
        });
        return Ok(undefined);
      }
      this._logger.error('Order version conflict during venue update', {
        orderId: String(orderId),
        updateType: update.type,
        expected: saveResult.error.expected,
        actual: saveResult.error.actual,
        latestStatus: latest.status,
      });
      return Err(new TradingError(
        `Order version conflict during venue update: ${saveResult.error.message}`,
        { context: { orderId: String(orderId), updateType: update.type, latestStatus: latest.status } },
      ));
    }

    // Шаг 5: Для venue-initiated терминальных статусов — освободить резервацию
    // Portfolio. REJECTED включён наравне с CANCELLED/EXPIRED: venue отклонил
    // уже сохранённый локальный ордер — live-ордера нет, резервация без release
    // осталась бы замороженной навсегда.
    // ТОЛЬКО после успешного CAS save: успех гарантирует, что между чтением
    // версии и записью не было конкурирующего fill (saveSync инкрементит
    // версию → был бы конфликт), т.е. резервация ещё не потреблена.
    //
    // Сбой release после committed save — Order↔Portfolio desync (замороженная
    // резервация): НЕ retryable business Err (update уже committed), логируем +
    // best-effort reconciliation issue и продолжаем к публикации/Ok.
    if (update.type === 'CANCELLED' || update.type === 'EXPIRED' || update.type === 'REJECTED') {
      const releaseResult = this._deps.portfolioService.releaseOrderReservation(accountId, updatedOrder);
      if (!releaseResult.ok) {
        this._logger.error('VENUE_UPDATE_RESERVATION_RELEASE_FAILED: reservation release failed after committed venue update — reservation may stay frozen', {
          orderId: String(orderId),
          updateType: update.type,
          error: releaseResult.error.message,
        });
        const instrumentId = assetIdToInstrumentId(updatedOrder.asset);
        await this._addReconciliationIssue({
          id: `reconciliation:order-update:${String(orderId)}:reservation-release-failed`,
          type: 'ORDER_PORTFOLIO_DESYNC',
          status: 'OPEN',
          reason: `VENUE_UPDATE_RESERVATION_RELEASE_FAILED: ${releaseResult.error.message}`,
          createdAt: this._deps.clock?.now() ?? new Date(),
          orderId,
          accountId,
          ...(instrumentId ? { instrumentId } : {}),
          context: {
            stage: 'venue-update-release-reservation-after-order-save',
            updateType: update.type,
          },
        });
      }
    }

    // Шаг 6: Опубликовать OrderEvent[].
    // Бизнес-коммит уже состоялся (CAS save + возможный reservation release) —
    // публикация является notification path, НЕ частью транзакции. Ошибка
    // publish НЕ откатывает состояние и НЕ делает committed update retryable:
    // логируем EVENT_PUBLISH_FAILED и продолжаем к Ok(undefined).
    if (events.length > 0) {
      try {
        await this._deps.eventBus.publishAll(events as readonly ApplicationEvent[]);
      } catch (err) {
        this._logger.error('EVENT_PUBLISH_FAILED: Failed to publish order events after commit — update stays applied, event lost', {
          orderId: String(orderId),
          updateType: update.type,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    this._logger.info('Order update applied', {
      orderId: String(orderId),
      updateType: update.type,
    });

    return Ok(undefined);
  }
}

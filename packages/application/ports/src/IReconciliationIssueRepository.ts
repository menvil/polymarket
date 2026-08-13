/**
 * Порт: хранилище operational/recovery reconciliation issues.
 *
 * @remarks
 * ### Зачем нужен отдельный репозиторий:
 * Manual reconciliation paths (`markReconciliationRequired`, UNKNOWN submit outcome,
 * FILLED-without-fill-details) раньше только логировались или помечали статус в
 * `IProcessedFillRepository`. Логи не queryable, а processed-fill статус привязан
 * к fillId и не покрывает submit/cancel сценарии без fill. Этот порт даёт единое
 * queryable/alertable хранилище проблем, требующих ручной реконсиляции.
 *
 * ### Что это НЕ:
 * Это repository для operational/recovery issues, НЕ для мутации trading state.
 * Создание issue никогда не должно менять Order/Portfolio/Ledger и никогда не
 * должно маскировать исходную trading-ошибку: если `add()` упал — caller обязан
 * залогировать сбой и продолжить исходный flow (вернуть исходный Result).
 *
 * ### Идемпотентность:
 * `add()` идемпотентен по `issue.id`: повторный `add` с тем же id НЕ создаёт
 * дубль и НЕ перезаписывает существующую issue. Поэтому id должен быть
 * детерминированным (например, `reconciliation:fill:${fillId}:order-portfolio-desync`),
 * чтобы retry того же сценария не плодил дубликаты.
 *
 * @example
 * ```typescript
 * const issue: ReconciliationIssue = {
 *   id: `reconciliation:fill:${fill.id}:order-portfolio-desync`,
 *   type: 'ORDER_PORTFOLIO_DESYNC',
 *   status: 'OPEN',
 *   reason: 'ORDER_PORTFOLIO_DESYNC: portfolio not found',
 *   createdAt: clock.now(),
 *   fillId: fill.id,
 *   orderId: fill.orderId,
 * };
 * try {
 *   await reconciliationIssues.add(issue);
 * } catch (err) {
 *   logger.error('Failed to add reconciliation issue', { issueId: issue.id });
 * }
 * ```
 */
import type { AccountId, FillId, InstrumentId, MarketId, OrderId } from '@polymarket/ids';

/**
 * Тип reconciliation issue — что именно рассинхронизировалось.
 *
 * @remarks
 * - `FILL_PARTIAL_COMMIT` — общий частичный commit при обработке fill (часть
 *   state-мутаций применена, часть — нет).
 * - `ORDER_PORTFOLIO_DESYNC` — Order уже сохранён с применённым fill, а
 *   Portfolio/Ledger обновить не удалось (см. `ProcessFillUseCase`).
 * - `SUBMIT_UNKNOWN_OUTCOME` — submit вернул UNKNOWN: venue-ордер может быть
 *   live, локальный Order не создан (см. `PlaceOrderUseCase`).
 * - `SUBMIT_FILLED_WITHOUT_FILL_DETAILS` — submit вернул FILLED без fill details:
 *   live-ордера уже нет, Portfolio нельзя обновить без реального Fill
 *   (ждём WS/reconciliation).
 * - `CANCEL_UNKNOWN_OUTCOME` — исход cancel неясен: venue-ордер может быть live.
 * - `VENUE_LOCAL_ORDER_DESYNC` — расхождение venue-состояния и локального Order.
 * - `EVENT_PUBLISH_FAILED` — доменное событие не опубликовано после commit
 *   (notification path упал): состояние закоммичено, но подписчики
 *   (strategy/bridge/projections) не уведомлены — требуется ручной replay.
 * - `RESERVATION_JOURNAL_DESYNC` — Order/Portfolio/Ledger уже закоммичены, а
 *   reservation journal transition упал: учёт резервации отстаёт от Portfolio,
 *   fill заблокирован до ручной реконсиляции (см. `ProcessFillUseCase`).
 */
export type ReconciliationIssueType =
  | 'FILL_PARTIAL_COMMIT'
  | 'ORDER_PORTFOLIO_DESYNC'
  | 'SUBMIT_UNKNOWN_OUTCOME'
  | 'SUBMIT_FILLED_WITHOUT_FILL_DETAILS'
  | 'CANCEL_UNKNOWN_OUTCOME'
  | 'VENUE_LOCAL_ORDER_DESYNC'
  | 'EVENT_PUBLISH_FAILED'
  | 'RESERVATION_JOURNAL_DESYNC';

/**
 * Статус жизненного цикла issue.
 *
 * @remarks
 * `OPEN` — требует ручного вмешательства. `RESOLVED` — вручную разрешена
 * (через `markResolved`); терминальный статус.
 */
export type ReconciliationIssueStatus = 'OPEN' | 'RESOLVED';

/**
 * Запись о проблеме, требующей ручной реконсиляции.
 *
 * @remarks
 * Immutable snapshot: реализации не должны возвращать live mutable references.
 * `id` — детерминированный ключ идемпотентности (см. doc порта).
 * Все ссылочные поля (`fillId`, `orderId`, ...) опциональны — заполняются
 * тем, что доступно в месте создания issue.
 * `context` — дополнительные non-sensitive диагностические значения
 * (error message, stage, cancelAttempted и т.п.).
 */
export interface ReconciliationIssue {
  /** Детерминированный уникальный ID issue (ключ идемпотентности `add()`) */
  readonly id: string;
  /** Тип рассинхронизации */
  readonly type: ReconciliationIssueType;
  /** Текущий статус (`OPEN` / `RESOLVED`) */
  readonly status: ReconciliationIssueStatus;
  /** Человекочитаемая причина (та же, что уходит в лог/markReconciliationRequired) */
  readonly reason: string;
  /** Момент создания issue */
  readonly createdAt: Date;
  /** Момент разрешения issue (только для `RESOLVED`) */
  readonly resolvedAt?: Date;

  /** ID fill-события, если issue связана с fill */
  readonly fillId?: FillId;
  /** ID ордера (venue orderId), если известен */
  readonly orderId?: OrderId;
  /** ID аккаунта, если известен */
  readonly accountId?: AccountId;
  /** ID инструмента, если известен */
  readonly instrumentId?: InstrumentId;
  /** ID рынка, если известен */
  readonly marketId?: MarketId;

  /** Дополнительный диагностический контекст (non-sensitive скаляры) */
  readonly context?: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Репозиторий reconciliation issues.
 *
 * @remarks
 * Контракт — см. doc порта выше. Ключевые гарантии:
 * - `add()` идемпотентен по `issue.id` (повторный add того же id — no-op,
 *   существующая issue НЕ перезаписывается);
 * - `markResolved()` для неизвестного id — документированный no-op (не бросает);
 * - методы чтения возвращают readonly snapshots, не live mutable references.
 */
export interface IReconciliationIssueRepository {
  /**
   * Добавляет новую issue.
   *
   * @param issue - Issue с детерминированным `id`
   *
   * @remarks
   * Идемпотентен по `issue.id`: если issue с таким id уже существует,
   * повторный вызов НЕ создаёт дубль и НЕ перезаписывает существующую запись.
   */
  add(issue: ReconciliationIssue): Promise<void>;

  /**
   * Возвращает все открытые (status === 'OPEN') issues.
   *
   * @returns Readonly-массив открытых issues (snapshot, не live reference)
   */
  listOpen(): Promise<readonly ReconciliationIssue[]>;

  /**
   * Возвращает issue по id.
   *
   * @param id - ID issue
   * @returns Issue или `undefined`, если id неизвестен
   */
  get(id: string): Promise<ReconciliationIssue | undefined>;

  /**
   * Помечает issue как разрешённую (`RESOLVED` + `resolvedAt`).
   *
   * @param id - ID issue
   * @param resolvedAt - Момент разрешения
   *
   * @remarks
   * Неизвестный id — документированный no-op (не бросает). Повторный вызов
   * для уже `RESOLVED` issue — тоже no-op (первый `resolvedAt` сохраняется).
   */
  markResolved(id: string, resolvedAt: Date): Promise<void>;
}

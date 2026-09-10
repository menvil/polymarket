/**
 * Единственный писатель приватного состояния торгового аккаунта.
 *
 * @remarks
 * Обработчики одного события в `IEventBus` выполняются ПАРАЛЛЕЛЬНО. Поэтому
 * несколько независимых подписчиков на исполнение — состояние, риск,
 * стратегия — читали бы и писали приватное состояние вперемешку, и порядок их
 * эффектов был бы не определён. Отсюда правило: подписан один проектор, а всё
 * остальное строится НАД готовым состоянием, а не рядом с ним.
 *
 * ### Два независимых проектора на одной шине
 *
 * ```text
 * IEventBus
 * ├── TradingStateProjector  → TradingHotState   факты о РЫНКЕ
 * └── AccountStateProjector  → AccountHotState   факты о НАС
 * ```
 *
 * Это законно именно потому, что они обрабатывают РАЗНЫЕ типы событий и не
 * зависят от side-effect'ов друг друга. Ни один обработчик здесь не
 * рассчитывает, что рыночный проектор «уже закончил», — такая связь была бы
 * гонкой, а не архитектурой. Согласованный снимок из обоих позже соберёт
 * `TradingContextBuilder` как read-only потребитель.
 *
 * ### Почему НЕ подписаны старые события
 *
 * ```text
 * FILL_RECEIVED / FILL_CONFIRMED / FILL_FAILED / DIRECT_FILL_APPLIED
 * ORDER_UPDATE_RECEIVED
 * ```
 *
 * Все они — ВХОД старого use-case flow: «наблюдение получено, его ещё надо
 * обработать». `ORDER_UPDATE_RECEIVED` вдобавок несёт сырой
 * `VenueOrderUpdate` без `Order` и без `Portfolio`. Приватному состоянию
 * нужен ИТОГ обработки, причём атомарно согласованный, поэтому у нового
 * контура свои события (`TRADING_ACCOUNT_*`). Семантика старых при этом не
 * меняется — они остаются своим потребителям.
 *
 * ### Почему НЕ подписаны Domain `OrderEvent`
 *
 * `ORDER_CREATED`/`ORDER_ACCEPTED`/`ORDER_PARTIALLY_FILLED`/… описывают
 * переход агрегата и НЕ несут портфель. Подписавшись на них, состояние
 * получило бы заявку без гарантии, что соответствующие резервации уже
 * материализованы, — то есть неверную свободную сумму ровно в тот момент,
 * когда по ней принимается следующее решение.
 *
 * ### Что на самом деле означает `critical: true`
 *
 * Ровно одно: отказ обработчика возвращается публикующей стороне как `Err` из
 * `IEventBus.publish()`, а не глотается шиной. Никакой автоматической
 * остановки торгового рантайма отсюда НЕ следует.
 *
 * **Как живой торговый контур реагирует на отказ приватной публикации —
 * отдельный вопрос, и он обязан быть решён fail-closed ДО включения
 * Strategy/Execution.** Для приватного состояния цена молчания выше, чем для
 * рыночного: разошедшийся ответ на вопрос «сколько у нас денег» приводит к
 * реальным заявкам на несуществующие средства.
 */
import type { IEventBus } from '@polymarket/event-bus';
import type {
  TradingAccountFillAppliedEvent,
  TradingAccountFillConfirmedEvent,
  TradingAccountFillRevertedEvent,
  TradingAccountFillVenueStatusObservedEvent,
  TradingAccountInitializedEvent,
  TradingAccountOrderCommittedEvent,
} from '@polymarket/application-events';
import { isErr } from '@polymarket/result';
import { AccountHotState } from './AccountHotState.js';
import type { AccountHotStateView } from './views.js';

/**
 * Типы событий, которые проектор принимает в состояние.
 *
 * @remarks
 * Только приватный контур нового торгового рантайма. Рыночные события,
 * legacy fill/order-события и Domain `OrderEvent` сюда не входят намеренно —
 * см. заголовок модуля.
 */
const PROJECTED_EVENT_TYPES = [
  'TRADING_ACCOUNT_INITIALIZED',
  'TRADING_ACCOUNT_ORDER_COMMITTED',
  'TRADING_ACCOUNT_FILL_APPLIED',
  'TRADING_ACCOUNT_FILL_CONFIRMED',
  'TRADING_ACCOUNT_FILL_REVERTED',
  'TRADING_ACCOUNT_FILL_VENUE_STATUS_OBSERVED',
] as const;

/**
 * Проецирует canonical `TRADING_ACCOUNT_*` события в приватное состояние.
 *
 * @example
 * ```typescript
 * const projector = AccountStateProjector.create(eventBus);
 * projector.start();
 * await eventBus.publish(initializedEvent);
 * const view = projector.state();
 * view.getAccount(venueId, accountId)?.portfolio.balance.available();
 * projector.stop();
 * ```
 */
export class AccountStateProjector {
  private _unsubscribes: Array<() => void> = [];

  private constructor(
    private readonly _eventBus: IEventBus,
    private readonly _state: AccountHotState,
  ) {}

  /**
   * Создаёт проектор вместе с состоянием, которым он владеет.
   *
   * @param eventBus - Шина canonical-событий приложения
   * @returns Проектор с пустым приватным состоянием
   *
   * @remarks
   * Состояние создаётся ВНУТРИ и наружу отдаётся только как
   * {@link AccountHotStateView}. Конкретный mutable-класс из пакета не
   * экспортируется вовсе — иначе правило «единственный писатель» осталось бы
   * комментарием: любой потребитель мог бы вызвать `applyFill()` или
   * `initializeAccount()` без единого приведения типов.
   *
   * В отличие от рыночного проектора здесь нет ни конфигурации хранения, ни
   * часов, поэтому создание не может отказать и `Result` не возвращается.
   * Часов нет сознательно: все времена берутся из `metadata.createdAt`.
   *
   * @example
   * ```typescript
   * const projector = AccountStateProjector.create(bus);
   * projector.start();
   * ```
   */
  public static create(eventBus: IEventBus): AccountStateProjector {
    return new AccountStateProjector(eventBus, new AccountHotState());
  }

  /**
   * Состояние только для чтения.
   *
   * @returns Проекция без возможности мутировать аккаунты, заявки и исполнения
   */
  public state(): AccountHotStateView {
    return this._state;
  }

  /** Проектор подписан на шину */
  public isRunning(): boolean {
    return this._unsubscribes.length > 0;
  }

  /**
   * Подписывает проектор на события приватного контура.
   *
   * @remarks
   * Повторный вызов ничего не делает: вторая подписка на те же типы означала
   * бы двойную обработку каждого события — то есть второй `version += 1` и
   * ложный конфликт идентичности на собственной же записи.
   *
   * Все подписки critical: отвергнутая приватная мутация обязана быть видна
   * публикующей стороне. Иначе рантайм считал бы исполнение применённым, а
   * деньги — потраченными, тогда как состояние их не приняло.
   *
   * @example
   * ```typescript
   * projector.start();
   * projector.start(); // no-op
   * ```
   */
  public start(): void {
    if (this.isRunning()) return;

    this._unsubscribes = [
      this._eventBus.subscribe(
        'TRADING_ACCOUNT_INITIALIZED',
        (event) => {
          this._onAccountInitialized(event as TradingAccountInitializedEvent);
        },
        { critical: true },
      ),
      this._eventBus.subscribe(
        'TRADING_ACCOUNT_ORDER_COMMITTED',
        (event) => {
          this._onOrderCommitted(event as TradingAccountOrderCommittedEvent);
        },
        { critical: true },
      ),
      this._eventBus.subscribe(
        'TRADING_ACCOUNT_FILL_APPLIED',
        (event) => {
          this._onFillApplied(event as TradingAccountFillAppliedEvent);
        },
        { critical: true },
      ),
      this._eventBus.subscribe(
        'TRADING_ACCOUNT_FILL_CONFIRMED',
        (event) => {
          this._onFillConfirmed(event as TradingAccountFillConfirmedEvent);
        },
        { critical: true },
      ),
      this._eventBus.subscribe(
        'TRADING_ACCOUNT_FILL_REVERTED',
        (event) => {
          this._onFillReverted(event as TradingAccountFillRevertedEvent);
        },
        { critical: true },
      ),
      this._eventBus.subscribe(
        'TRADING_ACCOUNT_FILL_VENUE_STATUS_OBSERVED',
        (event) => {
          this._onFillVenueStatusObserved(event as TradingAccountFillVenueStatusObservedEvent);
        },
        { critical: true },
      ),
    ];
  }

  /**
   * Снимает все подписки.
   *
   * @remarks
   * Повторный вызов безопасен. После остановки новые события состояние не
   * меняют.
   */
  public stop(): void {
    for (const unsubscribe of this._unsubscribes) unsubscribe();
    this._unsubscribes = [];
  }

  /** Типы событий, которые проектор принимает */
  public static projectedEventTypes(): readonly string[] {
    return PROJECTED_EVENT_TYPES;
  }

  /**
   * Принимает аккаунт к работе.
   *
   * @param event - Canonical `TRADING_ACCOUNT_INITIALIZED`
   * @throws {Error} При повторной инициализации или расхождении идентичности
   *   аккаунта, площадки либо портфеля
   *
   * @remarks
   * Время перехода — `metadata.createdAt`, а не показания часов: иначе replay
   * той же последовательности событий давал бы другие времена мутаций.
   */
  private _onAccountInitialized(event: TradingAccountInitializedEvent): void {
    const { venueId, accountId, portfolio } = event.payload;
    const applied = this._state.initializeAccount(
      venueId,
      accountId,
      portfolio,
      event.metadata.createdAt,
    );
    if (isErr(applied)) throw applied.error;
  }

  /**
   * Материализует итоговую заявку вместе с итоговым портфелем.
   *
   * @param event - Canonical `TRADING_ACCOUNT_ORDER_COMMITTED`
   * @throws {Error} При неизвестном аккаунте, отсутствующем или чужом
   *   владельце заявки, неразрешимом активе, расхождении идентичности
   *   портфеля либо конфликте идентичности заявки
   *
   * @remarks
   * Точный дубликат проходит без ошибки и без изменения состояния.
   */
  private _onOrderCommitted(event: TradingAccountOrderCommittedEvent): void {
    const { venueId, accountId, order, portfolio } = event.payload;
    const applied = this._state.commitOrder(
      venueId,
      accountId,
      order,
      portfolio,
      event.metadata.createdAt,
    );
    if (isErr(applied)) throw applied.error;
  }

  /**
   * Материализует применённое исполнение.
   *
   * @param event - Canonical `TRADING_ACCOUNT_FILL_APPLIED`
   * @throws {Error} При неизвестном аккаунте, расхождении идентичности
   *   портфеля, неразрешимом токене, разорванной связи заявки и исполнения
   *   либо конфликте факта исполнения
   *
   * @remarks
   * `venueId`/`accountId` берутся из самого `Fill` — в payload их нет, чтобы
   * не заводить второе место, которое обязано совпадать с первым.
   */
  private _onFillApplied(event: TradingAccountFillAppliedEvent): void {
    const { fill, portfolio, order } = event.payload;
    const applied = this._state.applyFill(fill, portfolio, order, event.metadata.createdAt);
    if (isErr(applied)) throw applied.error;
  }

  /**
   * Отмечает исполнение финальным.
   *
   * @param event - Canonical `TRADING_ACCOUNT_FILL_CONFIRMED`
   * @throws {Error} При неизвестном аккаунте, неизвестном исполнении,
   *   конфликте факта или запрещённом переходе
   *
   * @remarks
   * Портфель и заявка не меняются — их в payload и нет.
   */
  private _onFillConfirmed(event: TradingAccountFillConfirmedEvent): void {
    const applied = this._state.confirmFill(event.payload.fill, event.metadata.createdAt);
    if (isErr(applied)) throw applied.error;
  }

  /**
   * Записывает статус, о котором сообщила площадка.
   *
   * @param event - Canonical `TRADING_ACCOUNT_FILL_VENUE_STATUS_OBSERVED`
   * @throws {Error} При неизвестном аккаунте, неизвестном исполнении,
   *   конфликте факта либо двух разных терминальных исходах одной сделки
   *
   * @remarks
   * Вторая ось: ни портфель, ни заявка, ни runtime-статус не меняются.
   * Единственный путь, которым в состояние попадают `MINED` и `RETRYING` —
   * экономических двойников у них нет.
   *
   * Запоздавшее наблюдение после терминального исхода — не ошибка, а обычная
   * перестановка доставки: оно игнорируется, а не роняет публикацию.
   */
  private _onFillVenueStatusObserved(event: TradingAccountFillVenueStatusObservedEvent): void {
    const applied = this._state.observeFillVenueStatus(
      event.payload.fill,
      event.payload.venueStatus,
      event.metadata.createdAt,
    );
    if (isErr(applied)) throw applied.error;
  }

  /**
   * Откатывает ранее применённое исполнение.
   *
   * @param event - Canonical `TRADING_ACCOUNT_FILL_REVERTED`
   * @throws {Error} При неизвестном аккаунте или исполнении, расхождении
   *   идентичности портфеля, разорванной связи заявки и исполнения,
   *   конфликте факта либо попытке откатить подтверждённое исполнение
   */
  private _onFillReverted(event: TradingAccountFillRevertedEvent): void {
    const { fill, portfolio, order, reason } = event.payload;
    const applied = this._state.revertFill(
      fill,
      portfolio,
      order,
      reason,
      event.metadata.createdAt,
    );
    if (isErr(applied)) throw applied.error;
  }
}

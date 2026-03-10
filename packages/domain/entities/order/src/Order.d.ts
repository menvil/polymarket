/**
 * Агрегат Order — самодостаточная торговая заявка
 *
 * @remarks
 * Вся бизнес-логика сосредоточена в одном классе.
 * Внешние зависимости: @polymarket/result, @polymarket/errors, @polymarket/value-objects,
 * @polymarket/ids, decimal.js.
 *
 * ### Три фабрики:
 * - `create()`     — новая заявка (всегда PENDING), эмитирует OrderCreatedEvent
 * - `rehydrate()`  — восстановление из доверенного OrderState (без событий)
 * - `fromEvents()` — воспроизведение из лога событий (без событий)
 *
 * ### Domain Event Outbox:
 * Каждая успешная команда записывает событие в внутренний буфер.
 * Application-слой вызывает `pullEvents()` для извлечения и публикации.
 *
 * ### Жизненный цикл:
 * ```
 * PENDING → OPEN → PARTIALLY_FILLED → FILLED
 *     ↓       ↓            ↓
 * REJECTED  CANCELED    EXPIRED
 * ```
 *
 * ### Инварианты:
 * 1. Статус PENDING при создании — биржа ещё не подтвердила
 * 2. Только OPEN/PARTIALLY_FILLED могут принимать fill
 * 3. Fill не может превышать remainingSize
 * 4. Терминальные статусы (FILLED/CANCELED/REJECTED/EXPIRED) необратимы
 * 5. Все поля неизменяемы — методы возвращают новый экземпляр
 *
 * @example
 * ```typescript
 * // Создание новой заявки
 * const result = Order.create({
 *   id: asOrderId('order-1')!,
 *   asset: myAsset,
 *   side: 'BUY',
 *   price: Price.of(new Decimal('0.65')),
 *   size: Quantity.of(new Decimal('100')),
 *   timestamp: Timestamp.now(),
 * });
 *
 * if (result.ok) {
 *   const order = result.value;
 *   const events = order.pullEvents(); // [OrderCreatedEvent]
 *   const accepted = order.accept();
 *   if (accepted.ok) console.log(accepted.value.status); // 'OPEN'
 * }
 * ```
 */
import { Result } from '@polymarket/result';
import { Price, Quantity } from '@polymarket/value-objects';
import type { Side } from '@polymarket/value-objects';
import type { AssetId, FillId, OrderId } from '@polymarket/ids';
import Decimal from 'decimal.js';
import { type OrderStatus, type OrderState, type FillData, type CreateOrderParams, type OrderSnapshot } from './OrderState.js';
import type { OrderEvent } from './OrderEvents.js';
import { TradingError } from '@polymarket/errors';
/**
 * Агрегат Order — неизменяемая доменная сущность
 *
 * @remarks
 * Хранит состояние в приватном поле `_s: OrderState`.
 * Все публичные свойства — геттеры над `_s`.
 * Команды (accept, reject, cancel, expire, applyFill) возвращают новый экземпляр.
 * Каждая успешная команда записывает событие в `_pendingEvents`.
 * Вызов `pullEvents()` опустошает буфер.
 */
export declare class Order {
    private readonly _s;
    /** Буфер доменных событий (Domain Event Outbox) */
    private readonly _pendingEvents;
    private constructor();
    /** ID заявки */
    get id(): OrderId;
    /** Торгуемый актив */
    get asset(): AssetId;
    /** Сторона (BUY/SELL) */
    get side(): Side;
    /** Лимитная цена заявки */
    get price(): Price;
    /** Полный размер заявки */
    get size(): Quantity;
    /** Текущий статус */
    get status(): OrderStatus;
    /** Время создания заявки */
    get timestamp(): import("@polymarket/value-objects").Timestamp;
    /** Причина отклонения/отмены */
    get reason(): string | undefined;
    /** ID стратегии (для изоляции multi-strategy) */
    get strategyId(): string | undefined;
    /** Внутреннее состояние fills (filledSize, averagePrice, fillIds) */
    get fill(): import("./OrderState.js").FillState;
    /** Исполненный объём */
    get filledSize(): Quantity;
    /** Средневзвешенная цена исполнения (VWAP), undefined если нет fills */
    get averagePrice(): Price | undefined;
    /** Список ID всех применённых fills */
    get fillIds(): readonly FillId[];
    /** Количество применённых fills */
    get tradeCount(): number;
    /**
     * Оставшийся незаполненный объём
     *
     * @returns size - filledSize
     */
    get remainingSize(): Quantity;
    /**
     * Процент заполнения (0–100)
     *
     * @returns filledSize / size * 100
     */
    get fillPercentage(): Decimal;
    /**
     * Номинальная стоимость заявки
     *
     * @returns price * size
     */
    get notional(): Decimal;
    /** true если статус терминальный (FILLED/CANCELED/REJECTED/EXPIRED) */
    get isTerminal(): boolean;
    /** true если заявка может принимать fills (OPEN/PARTIALLY_FILLED) */
    get isFillable(): boolean;
    isPending(): boolean;
    isOpen(): boolean;
    isFilled(): boolean;
    isPartiallyFilled(): boolean;
    canCancel(): boolean;
    canModify(): boolean;
    /**
     * Извлекает накопленные доменные события и очищает буфер
     *
     * @returns Массив событий с момента последнего pullEvents()
     *
     * @remarks
     * Pattern: Domain Event Outbox.
     * Application-слой должен вызывать pullEvents() после каждой успешной команды
     * для публикации событий во внешние подписчики (шина, лог, проекции).
     *
     * Вызов pullEvents() опустошает буфер — следующий вызов вернёт [].
     * `rehydrate()` и `fromEvents()` не эмитируют событий.
     *
     * @example
     * ```typescript
     * const result = Order.create(params);
     * if (result.ok) {
     *   const events = result.value.pullEvents(); // [OrderCreatedEvent]
     *   await eventBus.publish(events);
     * }
     * ```
     */
    pullEvents(): readonly OrderEvent[];
    /**
     * Создаёт новую заявку (всегда PENDING)
     *
     * @param params - Параметры новой заявки
     * @returns Result<Order, TradingError>
     *
     * @remarks
     * Единственная точка создания заявки в рамках нормального бизнес-потока.
     * Статус всегда PENDING — биржа ещё не подтвердила.
     * Эмитирует OrderCreatedEvent в буфер (pullEvents() вернёт его).
     *
     * Для восстановления существующей заявки → rehydrate() или fromEvents().
     *
     * @example
     * ```typescript
     * const result = Order.create({
     *   id: asOrderId('order-1')!,
     *   asset: myAsset,
     *   side: 'BUY',
     *   price: Price.of(new Decimal('0.65')),
     *   size: Quantity.of(new Decimal('100')),
     *   timestamp: Timestamp.now(),
     * });
     * if (result.ok) {
     *   const events = result.value.pullEvents(); // [OrderCreatedEvent]
     * }
     * ```
     */
    static create(params: CreateOrderParams): Result<Order, TradingError>;
    /**
     * Восстанавливает заявку из доверенного состояния (rehydration)
     *
     * @param state - Внутреннее состояние заявки с value objects
     * @returns Result<Order, TradingError>
     *
     * @remarks
     * В отличие от create() не применяет бизнес-валидацию — состояние уже прошло
     * через доменную логику ранее.
     *
     * Используется OrderDeserializer после парсинга снэпшота из БД или API.
     *
     * Проверяет консистентность состояния (кросс-поля):
     * - filledSize не может превышать size
     * - PENDING заявка не может иметь fills
     * - FILLED заявка должна быть полностью исполнена
     *
     * Не эмитирует события — pullEvents() вернёт [].
     *
     * @example
     * ```typescript
     * const result = Order.rehydrate(state);
     * if (result.ok) {
     *   console.log(result.value.status);
     *   result.value.pullEvents(); // всегда []
     * }
     * ```
     */
    static rehydrate(state: OrderState): Result<Order, TradingError>;
    /**
     * Воспроизводит заявку из лога событий (replay mode)
     *
     * @param events - Последовательность событий в хронологическом порядке; первое должно быть ORDER_CREATED
     * @returns `Ok(Order)` при успехе, `Err(TradingError)` если массив пуст или первое событие не ORDER_CREATED
     * @throws Не бросает исключений — все ошибки возвращаются через Result
     *
     * @remarks
     * Применяет события без валидации — предполагает корректность лога.
     * Используется для воспроизведения истории в режиме paper trading или анализа.
     * Не эмитирует события — pullEvents() вернёт [].
     *
     * @example
     * ```typescript
     * const result = Order.fromEvents([
     *   { type: 'ORDER_CREATED', orderId, asset, side: 'BUY', price, size, timestamp },
     *   { type: 'ORDER_ACCEPTED', orderId },
     *   { type: 'ORDER_FILLED', orderId, fill: fillData, averagePrice },
     * ]);
     * if (result.ok) console.log(result.value.status); // 'FILLED'
     * ```
     */
    static fromEvents(events: readonly OrderEvent[]): Result<Order, TradingError>;
    /**
     * Применяет событие к состоянию — единственный источник истины для переходов
     *
     * @param state - Текущее состояние
     * @param event - Событие для применения
     * @returns Новое состояние (без изменений если событие не применимо)
     *
     * @remarks
     * Используется двояко:
     * 1. В командах (accept, reject, cancel, expire, applyFill) — state derived from event
     * 2. В fromEvents() — replay лога событий без валидации
     *
     * Гарантии безопасности:
     * - Если orderId события не совпадает с id текущего состояния — событие игнорируется
     *   (silent corruption prevention при попадании чужого события в поток)
     * - Статус-гарды предотвращают недопустимые переходы при replay
     *
     * Это гарантирует, что переход состояния всегда проходит через один код,
     * а не дублируется в каждой команде.
     */
    private static _applyEventToState;
    /**
     * Принять заявку биржей
     *
     * @returns Result<Order, TradingError>
     *
     * @remarks
     * Переход: PENDING → OPEN
     * Биржа подтвердила получение и выставила заявку на исполнение.
     * Эмитирует OrderAcceptedEvent.
     *
     * @example
     * ```typescript
     * const result = order.accept();
     * if (result.ok) console.log(result.value.status); // 'OPEN'
     * ```
     */
    accept(): Result<Order, TradingError>;
    /**
     * Отклонить заявку биржей
     *
     * @param reason - Причина отклонения (обязательна)
     * @returns Result<Order, TradingError>
     *
     * @remarks
     * Переход: PENDING → REJECTED
     * Биржа отклонила заявку (недостаточно средств, невалидная цена и т.д.)
     * Эмитирует OrderRejectedEvent.
     *
     * @example
     * ```typescript
     * const result = order.reject('Insufficient funds');
     * if (result.ok) console.log(result.value.reason); // 'Insufficient funds'
     * ```
     */
    reject(reason: string): Result<Order, TradingError>;
    /**
     * Отменить заявку
     *
     * @param reason - Причина отмены (опционально, по умолчанию 'User cancelled')
     * @returns Result<Order, TradingError>
     *
     * @remarks
     * Переход: OPEN или PARTIALLY_FILLED → CANCELED
     * Заявка снята с биржи по инициативе пользователя или риск-системы.
     * Эмитирует OrderCancelledEvent.
     *
     * @example
     * ```typescript
     * const result = order.cancel('Risk limit exceeded');
     * if (result.ok) console.log(result.value.status); // 'CANCELED'
     * ```
     */
    cancel(reason?: string): Result<Order, TradingError>;
    /**
     * Истечь заявке по времени
     *
     * @returns Result<Order, TradingError>
     *
     * @remarks
     * Переход: OPEN или PARTIALLY_FILLED → EXPIRED
     * Автоматически вызывается при истечении TTL заявки.
     * Эмитирует OrderExpiredEvent.
     *
     * @example
     * ```typescript
     * const result = order.expire();
     * if (result.ok) console.log(result.value.status); // 'EXPIRED'
     * ```
     */
    expire(): Result<Order, TradingError>;
    /**
     * Применить fill исполнения к заявке
     *
     * @param fill - Данные исполнения
     * @returns Result<Order, TradingError>
     *
     * @remarks
     * Переходы:
     * - OPEN → PARTIALLY_FILLED (если остаток > 0) → эмитирует OrderPartiallyFilledEvent
     * - OPEN или PARTIALLY_FILLED → FILLED (если остаток = 0) → эмитирует OrderFilledEvent
     *
     * Валидирует:
     * - Статус OPEN или PARTIALLY_FILLED
     * - fill.asset совпадает с order.asset
     * - fill.side совпадает с order.side
     * - fill.orderId совпадает с order.id
     * - fill.size > 0 и не превышает remainingSize
     * - fill.id не дублируется
     *
     * @example
     * ```typescript
     * const result = order.applyFill({ id: fillId, orderId, asset, side: 'BUY', size, price });
     * if (result.ok) console.log(result.value.filledSize.value().toNumber()); // 30
     * ```
     */
    applyFill(fill: FillData): Result<Order, TradingError>;
    /**
     * Проверяет возможность принятия fill без применения
     *
     * @param fill - Данные исполнения для проверки
     * @returns true если fill может быть применён
     *
     * @remarks
     * Быстрая проверка перед вызовом applyFill().
     * Паритет с applyFill(): если canAcceptFill() == false, то applyFill() вернёт Err.
     *
     * @example
     * ```typescript
     * if (order.canAcceptFill(fill)) {
     *   const result = order.applyFill(fill);
     * }
     * ```
     */
    canAcceptFill(fill: FillData): boolean;
    /**
     * Создаёт снэпшот заявки с примитивными типами
     *
     * @returns OrderSnapshot — плоский объект с примитивами
     *
     * @remarks
     * Используется для персистентности (БД, кэш) и синхронизации с биржей.
     * Round-trip: Order.rehydrate(parsed(order.toSnapshot())) воспроизводит тот же Order.
     *
     * @example
     * ```typescript
     * const snap = order.toSnapshot();
     * const restored = OrderDeserializer.fromSnapshot(snap);
     * ```
     */
    toSnapshot(): OrderSnapshot;
    /**
     * Строковое представление для логирования
     *
     * @returns Читаемая строка с основными полями заявки
     *
     * @example
     * ```typescript
     * console.log(order.toString());
     * // "Order[order-1]: BUY 100 @ 0.65 (OPEN)"
     * ```
     */
    toString(): string;
}
//# sourceMappingURL=Order.d.ts.map
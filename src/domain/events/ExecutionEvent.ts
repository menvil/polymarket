/**
 * ExecutionEvent - ТОЛЬКО факты внешнего мира (биржа, CLOB API)
 *
 * @remarks
 * Только OrderAccepted, OrderFilled, OrderPartiallyFilled, OrderCancelled, OrderRejected!
 *
 * Execution остаётся чистым.
 * Можно реплеить execution-stream из биржевых логов.
 *
 * Если событие НЕ факт биржи → оно НЕ ExecutionEvent.
 *
 * Принципы:
 * - ExecutionEvent = факты внешнего мира (биржа, CLOB API)
 * - Самодостаточный (детерминированный без внешнего состояния)
 * - Включает timestamp для детерминированного воспроизведения (v4)
 * - OrderAccepted содержит минимальный контекст (side, marketId, price, size)
 * - Неизменяемые факты
 *
 */
export type ExecutionEvent =
  | OrderAccepted
  | OrderPartiallyFilled
  | OrderFilled
  | OrderCancelled
  | OrderRejected;

/**
 * ExecutionErrorEvent - ошибки исполнения (для метрик/логирования)
 *
 * Обработка:
 * - ErrorMetricsProjector подписывается
 * - Может быть отдельный ErrorEventBus / topic
 */
export type ExecutionErrorEvent =
  | OrderRejected
  | OrderValidationFailed;

/**
 * OrderAccepted - ордер принят биржей
 *
 * @remarks
 * OrderAccepted содержит MINIMAL CONTEXT
 *
 * Почему context необходим:
 * - Projector должен создать Order aggregate детерминированно
 * - Нет реестра ожидающих ордеров (скрытое состояние, не событийное, не пригодно для воспроизведения)
 * - ExecutionEvent = самодостаточный (без внешних зависимостей)
 * - side, marketId, price, size - факты времени исполнения, не бизнес-решения
 *
 * Контекст = минимальный:
 * - side: BUY | SELL (факт исполнения)
 * - marketId: string (где исполняется)
 * - price: number (лимит цена, принятая биржей)
 * - size: number (размер, принятый биржей)
 *
 *
 * Инварианты проверяются в AGGREGATE, не в mapper
 * - Mapper = чистый парсинг (может вернуть price=0 для воспроизведения на грязных данных)
 * - Aggregate проверяет: price > 0, size > 0, marketId непустой
 */
export interface OrderAccepted {
  readonly type: 'OrderAccepted';
  readonly orderId: string; // Биржевой ID
  readonly strategyId: string;
  readonly marketId: string; // Идентификатор рынка
  readonly tokenId: string; // Идентификатор токена
  readonly side: 'BUY' | 'SELL';
  readonly price: number; // Aggregate проверит > 0
  readonly size: number; // Aggregate проверит > 0
  readonly timestamp: Date; // для deterministic replay
}

/**
 * OrderPartiallyFilled - ордер частично исполнен
 *
 * @remarks
 * filledDelta - сколько исполнилось В ЭТОМ событии (дельта)
 * Aggregate вычисляет totalFilled = previousFilled + filledDelta
 *
 * price - цена ЭТОГО исполнения (для взвешенного среднего в aggregate)
 *
 * Инварианты в AGGREGATE
 * - Mapper НЕ проверяет filledDelta > 0 (воспроизведение на грязных данных)
 * - Aggregate проверяет: filledDelta > 0, price > 0
 */
export interface OrderPartiallyFilled {
  readonly type: 'OrderPartiallyFilled';
  readonly orderId: string;
  readonly strategyId: string; // для multi-strategy изоляции
  readonly tokenId: string; // для PortfolioProjector
  readonly marketId: string;
  readonly side: 'BUY' | 'SELL'; // для PortfolioProjector
  readonly filledDelta: number; // DELTA, NOT total
  readonly price: number; // Цена ЭТОГО исполнения
  readonly timestamp: Date; // для deterministic replay
}

/**
 * OrderFilled - ордер полностью исполнен
 *
 * @remarks
 * filledDelta - последний кусок (delta)
 * После этого события aggregate проверяет invariant: totalFilled === Order.size
 *
 */
export interface OrderFilled {
  readonly type: 'OrderFilled';
  readonly orderId: string;
  readonly strategyId: string;
  readonly tokenId: string;
  readonly marketId: string;
  readonly side: 'BUY' | 'SELL';
  readonly filledDelta: number; // DELTA последнего fill
  readonly price: number;
  readonly timestamp: Date; // для deterministic replay

  // Причина исполнения ордера (критично для статистики!)
  // Строковый литеральный тип, соответствующий значениям enum FillReason + 'REAL' для реальной торговли
  readonly fillReason?: 'CROSSED_BOOK' | 'TRADE_THROUGH' | 'BOOK_TOUCH' | 'REAL';

  // Доступный объем на уровне в момент исполнения
  readonly availableVolume?: number;

  // Состояние Orderbook в момент исполнения (для отладки)
  readonly orderbookSnapshot?: {
    bestBid: number;
    bestAsk: number;
  };
}

/**
 * OrderCancelled - ордер отменён
 */
export interface OrderCancelled {
  readonly type: 'OrderCancelled';
  readonly orderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly strategyId: string;
  readonly reason?: string;
  readonly timestamp: Date; // для deterministic replay
}

/**
 * OrderRejected - ордер отклонён биржей
 *
 * Семантика:
 * - OrderRejected = execution error, НО также часть ExecutionEvent (для FSM)
 * - Для DumbStrategy FSM: OrderRejected → STOPPED state
 * - Для metrics/logging: также в ExecutionErrorEvent
 *
 * orderId может быть undefined - ордер не дошёл до биржи (validation error)
 */
export interface OrderRejected {
  readonly type: 'OrderRejected';
  readonly orderId?: string; // Может быть undefined если ордер не дошёл до биржи
  readonly strategyId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly reason: string;
  readonly errorCode?: string;
  readonly timestamp: Date; // для deterministic replay
}

/**
 * OrderValidationFailed - ордер не прошёл validation до отправки на биржу
 *
 * @remarks
 * OrderValidationFailed = ExecutionErrorEvent (pre-execution error)
 *
 * Отличие от OrderRejected:
 * - OrderRejected = биржа отклонила
 * - OrderValidationFailed = не дошёл до биржи (pre-flight validation)
 */
export interface OrderValidationFailed {
  readonly type: 'OrderValidationFailed';
  readonly orderId?: string; // Может быть undefined если ID не сгенерирован
  readonly strategyId: string; // v4.2: для multi-strategy изоляции
  readonly reason: string;
  readonly validationErrors: Record<string, string>; // field → error message
  readonly timestamp: Date; // для deterministic replay
}

// Type guards для ExecutionEvent (используются ТОЛЬКО в infrastructure, НЕ в projectors)
export function isOrderAccepted(event: ExecutionEvent): event is OrderAccepted {
  return event.type === 'OrderAccepted';
}

export function isOrderPartiallyFilled(event: ExecutionEvent): event is OrderPartiallyFilled {
  return event.type === 'OrderPartiallyFilled';
}

export function isOrderFilled(event: ExecutionEvent): event is OrderFilled {
  return event.type === 'OrderFilled';
}

export function isOrderCancelled(event: ExecutionEvent): event is OrderCancelled {
  return event.type === 'OrderCancelled';
}

// Type guards для ExecutionErrorEvent (ошибки исполнения)
export function isOrderRejected(event: ExecutionEvent | ExecutionErrorEvent): event is OrderRejected {
  return event.type === 'OrderRejected';
}

export function isOrderValidationFailed(event: ExecutionErrorEvent): event is OrderValidationFailed {
  return event.type === 'OrderValidationFailed';
}

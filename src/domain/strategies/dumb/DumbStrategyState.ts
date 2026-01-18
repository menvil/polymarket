/**
 * DumbStrategyStateData - fully event-sourced state
 *
 * @remarks
 * КРИТИЧНО v3: State = полностью производная от StrategyEvent stream
 *
 * Правила v3:
 * - Переходы ТОЛЬКО через StrategyEvent (ExecutionEvent | LifecycleEvent)
 * - State включает ВСЕ поля (NO скрытых полей вне state)
 * - FSM reducer восстанавливает ВСЁ из StrategyEvent stream
 * - onTick() НЕ меняет state
 * - Таймер НЕ триггерит transitions
 *
 * Жёсткое правило v3:
 * Если поле нельзя восстановить из StrategyEvent stream → его не должно быть.
 *
 * FSM transitions v4:
 * IDLE → (StrategyStarted: LifecycleEvent) → IDLE (но lastSide установлен)
 * IDLE → (OrderAccepted: ExecutionEvent) → QUOTING
 * QUOTING → (OrderPartiallyFilled: ExecutionEvent) → QUOTING
 * QUOTING → (OrderFilled: ExecutionEvent) → FILLED
 * FILLED → (OrderAccepted: ExecutionEvent, reverse order) → QUOTING
 * ANY → (OrderCancelled | OrderRejected: ExecutionEvent) → STOPPED
 *
 * @example
 * ```typescript
 * // Пример восстановления state из event stream:
 * let state: DumbStrategyStateData = { tag: 'IDLE' };
 *
 * // Event 1: StrategyStarted (LifecycleEvent)
 * state = reduce(state, { type: 'StrategyStarted', ... }, config);
 * // → { tag: 'IDLE', lastSide: 'buy' } (lastSide восстановлен из config)
 *
 * // Event 2: OrderAccepted (ExecutionEvent)
 * state = reduce(state, { type: 'OrderAccepted', orderId: '123', ... });
 * // → { tag: 'QUOTING', currentOrderId: '123', lastSide: 'buy' }
 *
 * // Event 3: OrderFilled (ExecutionEvent)
 * state = reduce(state, { type: 'OrderFilled', ... });
 * // → { tag: 'FILLED', lastSide: 'buy' } (готов к reverse order)
 *
 * // ✅ State полностью восстановлен из event stream
 * // ✅ NO скрытых полей
 * // ✅ Replay = bit-for-bit те же state transitions
 * ```
 */

/**
 * State tags (phase of strategy)
 *
 * @remarks
 * IDLE: Стратегия стартовала, ждёт первого OrderAccepted
 * QUOTING: Активный ордер на бирже
 * FILLED: Ордер исполнен, готов к размещению reverse order
 * STOPPED: Терминальное состояние (ошибка или отмена)
 */
export type DumbStrategyTag = 'IDLE' | 'QUOTING' | 'FILLED' | 'STOPPED';

/**
 * DumbStrategyStateData - fully event-sourced state
 *
 * @remarks
 * КРИТИЧНО v3: ВСЁ состояние в одном объекте.
 * NO private fields вне state.
 * Всё восстанавливается из StrategyEvent stream.
 *
 * v4: State восстанавливается из Union<ExecutionEvent | LifecycleEvent>
 *
 * @property tag - Current phase of strategy
 * @property currentOrderId - ID активного ордера (если есть)
 * @property lastSide - Последняя сторона ордера (для reverse orders)
 *
 * @example
 * ```typescript
 * // IDLE state (начальное):
 * const state1: DumbStrategyStateData = { tag: 'IDLE' };
 *
 * // IDLE state (после StrategyStarted):
 * const state2: DumbStrategyStateData = {
 *   tag: 'IDLE',
 *   lastSide: 'buy', // ✅ восстановлено из config
 * };
 *
 * // QUOTING state:
 * const state3: DumbStrategyStateData = {
 *   tag: 'QUOTING',
 *   currentOrderId: '123abc', // ✅ восстановлено из OrderAccepted
 *   lastSide: 'buy',
 * };
 *
 * // FILLED state:
 * const state4: DumbStrategyStateData = {
 *   tag: 'FILLED',
 *   lastSide: 'buy', // ✅ сохранён для reverse order
 * };
 *
 * // STOPPED state:
 * const state5: DumbStrategyStateData = {
 *   tag: 'STOPPED',
 *   // currentOrderId и lastSide могут отсутствовать
 * };
 * ```
 */
export interface DumbStrategyStateData {
  /** Current phase */
  readonly tag: DumbStrategyTag;

  /**
   * Current order ID (если есть активный ордер)
   *
   * @remarks
   * Установлен в state QUOTING.
   * Восстанавливается из ExecutionEvent: OrderAccepted.
   * Очищается при переходе в FILLED или STOPPED.
   */
  readonly currentOrderId?: string;

  /**
   * Current order price (цена текущего активного ордера)
   *
   * @remarks
   * v5.2: Используется для virtual fill detection.
   * Установлен в state QUOTING из event.price.
   * Очищается при переходе в FILLED или STOPPED.
   *
   * Важно: цена берётся из OrderAccepted event, НЕ из config!
   * Потому что ордера размещаются по динамическим ценам из orderbook.
   */
  readonly currentOrderPrice?: number;

  /**
   * Last side (для генерации reverse orders)
   *
   * @remarks
   * Установлен в IDLE после LifecycleEvent: StrategyStarted.
   * Используется для генерации reverse orders в FILLED state.
   * Восстанавливается из config (initialSide) или предыдущего state.
   */
  readonly lastSide?: 'buy' | 'sell';

  /**
   * v5.4: Флаг репозиционирования
   *
   * @remarks
   * Устанавливается в true когда стратегия отменяет ордер для репозиционирования.
   * При получении OrderCancelled с этим флагом FSM переходит в IDLE (не STOPPED),
   * чтобы можно было разместить новый ордер.
   *
   * Flow:
   * 1. Deviation > 8% → strategy sets isRepositioning=true, calls cancelOrder
   * 2. OrderCancelled arrives → FSM sees isRepositioning → transitions to IDLE
   * 3. Strategy generates new order intent
   */
  readonly isRepositioning?: boolean;

  /**
   * v5.6: Цена последнего fill (для расчёта минимальной цены продажи)
   *
   * @remarks
   * КРИТИЧНО: Сохраняется при OrderFilled для гарантии прибыльной продажи!
   *
   * Проблема: Если рынок упал после BUY, текущая логика (SELL = bestAsk * 1.02)
   * могла продавать в убыток (SELL price < BUY price).
   *
   * Решение: Сохраняем цену fill и используем её как минимум для SELL:
   * - SELL price = max(bestAsk * 1.02, lastFillPrice + minProfit)
   *
   * Flow:
   * 1. BUY @ 0.55 → lastFillPrice = 0.55
   * 2. Market drops, bestAsk = 0.50
   * 3. SELL price = max(0.50 * 1.02, 0.55 + 0.01) = max(0.51, 0.56) = 0.56
   * 4. Гарантированная прибыль!
   */
  readonly lastFillPrice?: number;

  /**
   * v6.0: Размер последнего fill (для reverse ордера)
   *
   * @remarks
   * КРИТИЧНО: Сохраняется при OrderFilled для продажи ТОЧНО ТОГО ЖЕ размера!
   *
   * Проблема:
   * - BUY: может быть любого размера (минимум 1 share)
   * - SELL: если использовать config.size, может не совпадать с позицией!
   *
   * Решение: Сохраняем реальный размер fill и используем его для reverse ордера.
   *
   * Flow:
   * 1. BUY 1 share @ $0.47
   * 2. OrderFilled → lastFillSize = 1
   * 3. SELL 1 share @ $0.50 (используем lastFillSize!)
   */
  readonly lastFillSize?: number;

  /**
   * v6.3: Счетчик открытых ордеров (на бирже)
   *
   * @remarks
   * КРИТИЧНО: Предотвращает набор позиций!
   *
   * Проблема:
   * - Стратегия генерирует интенты не дожидаясь OrderAccepted
   * - Результат: много ордеров на бирже одновременно
   *
   * Решение: Счетчик открытых ордеров.
   * - Увеличивается при OrderAccepted
   * - Уменьшается при OrderFilled (полное), OrderCancelled, OrderRejected
   * - Проверка перед генерацией интента: если openOrdersCount > 0, не генерировать!
   *
   * Flow:
   * 1. Generate intent → openOrdersCount остается 0
   * 2. OrderAccepted → openOrdersCount = 1
   * 3. StrategyTick → проверка: openOrdersCount > 0 → НЕ генерируем новый intent!
   * 4. OrderFilled → openOrdersCount = 0
   * 5. Теперь можем генерировать новый intent
   */
  readonly openOrdersCount?: number;

  /**
   * v7.7.13: FIFO очередь открытых позиций
   *
   * @remarks
   * КРИТИЧНО: Для правильного расчета цены SELL на основе FIFO!
   *
   * Проблема:
   * - Одна позиция (lastFillPrice) не учитывает несколько покупок по разным ценам
   * - Пример: BUY 15@50¢, BUY 5@55¢ → нужно продавать сначала 15@52¢, потом 5@57.2¢
   *
   * Решение: FIFO очередь позиций.
   * - При BUY fill: добавляем позицию в конец очереди
   * - При SELL fill: вычитаем из начала очереди (FIFO)
   * - При CASE C: берем цену первой позиции * 1.04
   *
   * Flow:
   * 1. BUY 15 @ 50¢ → positions = [{price: 50, size: 15, remaining: 15}]
   * 2. BUY 5 @ 55¢ → positions = [{price: 50, size: 15, remaining: 15}, {price: 55, size: 5, remaining: 5}]
   * 3. SELL 10 @ 60¢ → positions = [{price: 50, size: 15, remaining: 5}, {price: 55, size: 5, remaining: 5}]
   * 4. CASE C: price = 50 * 1.04 = 52¢, size = 5 (закрыть первую позицию)
   * 5. SELL 5 @ 52¢ → positions = [{price: 55, size: 5, remaining: 5}]
   * 6. CASE C: price = 55 * 1.04 = 57.2¢, size = 5 (закрыть вторую позицию)
   */
  readonly positions?: Position[];
}

/**
 * Position - открытая позиция в FIFO очереди
 *
 * @remarks
 * v7.7.13: Структура для FIFO очереди позиций
 */
export interface Position {
  /** Цена покупки */
  readonly price: number;
  /** Размер позиции (изначальный) */
  readonly size: number;
  /** Оставшийся размер (непроданный) */
  readonly remainingSize: number;
}

/**
 * Allowed transitions matrix
 *
 * @remarks
 * Все transitions ТОЛЬКО через StrategyEvent.
 *
 * v4: StrategyEvent = ExecutionEvent | LifecycleEvent
 * - LifecycleEvent: StrategyStarted, StrategyStopped
 * - ExecutionEvent: OrderAccepted, OrderPartiallyFilled, OrderFilled, OrderCancelled, OrderRejected
 *
 * Transition rules:
 * - IDLE может остаться в IDLE (StrategyStarted: LifecycleEvent)
 * - IDLE → QUOTING (OrderAccepted: ExecutionEvent)
 * - IDLE → STOPPED (OrderRejected: ExecutionEvent)
 * - QUOTING → QUOTING (OrderPartiallyFilled: ExecutionEvent)
 * - QUOTING → FILLED (OrderFilled: ExecutionEvent)
 * - QUOTING → STOPPED (OrderCancelled: ExecutionEvent)
 * - FILLED → QUOTING (OrderAccepted: ExecutionEvent, reverse order)
 * - FILLED → STOPPED (OrderRejected: ExecutionEvent, reverse order failed)
 * - STOPPED → [] (terminal state, NO transitions)
 */
export const ALLOWED_TRANSITIONS: Record<DumbStrategyTag, DumbStrategyTag[]> = {
  IDLE: [
    'IDLE', // StrategyStarted (LifecycleEvent) - остаёмся в IDLE, устанавливаем lastSide
    'QUOTING', // OrderAccepted (ExecutionEvent) - первый ордер размещён
    'STOPPED', // OrderRejected (ExecutionEvent) - первый ордер отклонён
  ],
  QUOTING: [
    'QUOTING', // OrderPartiallyFilled (ExecutionEvent) - частичное исполнение
    'FILLED', // OrderFilled (ExecutionEvent) - полное исполнение
    'IDLE', // v5.4: OrderCancelled (ExecutionEvent) with isRepositioning=true
    'STOPPED', // OrderCancelled (ExecutionEvent) - ордер отменён
  ],
  FILLED: [
    'FILLED', // StrategyTick (no state change) - ждём OrderAccepted для reverse order
    'QUOTING', // OrderAccepted (ExecutionEvent) - reverse order размещён
    'STOPPED', // OrderRejected (ExecutionEvent) - reverse order отклонён
  ],
  STOPPED: [], // Terminal state (NO transitions)
};

/**
 * Check if transition is allowed
 *
 * @param from - Current state tag
 * @param to - Target state tag
 * @returns true if transition is allowed
 *
 * @remarks
 * Используется FSM reducer для валидации transitions.
 * Если transition не разрешён → FSM reducer бросает исключение.
 *
 * @example
 * ```typescript
 * // ✅ Allowed transitions:
 * isAllowedTransition('IDLE', 'IDLE'); // → true (StrategyStarted)
 * isAllowedTransition('IDLE', 'QUOTING'); // → true (OrderAccepted)
 * isAllowedTransition('QUOTING', 'FILLED'); // → true (OrderFilled)
 * isAllowedTransition('FILLED', 'QUOTING'); // → true (reverse order)
 *
 * // ❌ Illegal transitions:
 * isAllowedTransition('STOPPED', 'IDLE'); // → false (terminal state)
 * isAllowedTransition('IDLE', 'FILLED'); // → false (пропущен QUOTING)
 * ```
 */
export function isAllowedTransition(from: DumbStrategyTag, to: DumbStrategyTag): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Check if state is terminal
 *
 * @param state - Strategy state
 * @returns true if state is terminal (STOPPED)
 *
 * @remarks
 * Terminal state = NO дальнейших transitions.
 * Стратегия должна остановиться.
 *
 * @example
 * ```typescript
 * const state1: DumbStrategyStateData = { tag: 'QUOTING', currentOrderId: '123', lastSide: 'buy' };
 * isTerminalState(state1); // → false
 *
 * const state2: DumbStrategyStateData = { tag: 'STOPPED' };
 * isTerminalState(state2); // → true
 * ```
 */
export function isTerminalState(state: DumbStrategyStateData): boolean {
  return state.tag === 'STOPPED';
}

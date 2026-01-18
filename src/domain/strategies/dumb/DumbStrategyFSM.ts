/**
 * DumbStrategyFSM - pure reducer ТОЛЬКО на StrategyEvent
 *
 * @remarks
 * КРИТИЧНО v7.7.15: FSM реактивна на StrategyEvent = ExecutionEvent | LifecycleEvent | TickEvent
 *
 * FSM reducer = pure function: (state, StrategyEvent, config) → newState
 *
 * Жёсткие правила v7.7.15:
 * - Единственный input - StrategyEvent (ExecutionEvent | LifecycleEvent | TickEvent)
 * - ВСЁ состояние восстанавливается из event
 * - NO таймеров, NO internal events
 * - NO скрытых полей вне state
 * - LifecycleEvent: StrategyStarted, StrategyStopped
 * - ExecutionEvent: OrderAccepted, OrderCancelled, OrderRejected
 * - TickEvent: StrategyTick
 *
 * v4 changes:
 * - Обрабатывает LifecycleEvent (StrategyStarted) отдельно от ExecutionEvent
 * - Честные типы: ExecutionEvent ≠ LifecycleEvent
 * - StrategyEvent = union обоих типов
 *
 * @example
 * ```typescript
 * let state: DumbStrategyStateData = { tag: 'IDLE' };
 *
 * // LifecycleEvent: StrategyStarted
 * state = reduce(state, {
 *   type: 'StrategyStarted',
 *   strategyId: 'dumb-1',
 *   timestamp: new Date()
 * }, config);
 * // → { tag: 'IDLE', lastSide: 'buy' } (lastSide восстановлен из config)
 *
 * // ExecutionEvent: OrderAccepted
 * state = reduce(state, {
 *   type: 'OrderAccepted',
 *   orderId: '123',
 *   side: 'BUY',
 *   marketId: '0xabc',
 *   price: 0.52,
 *   size: 100,
 *   timestamp: new Date()
 * }, config);
 * // → { tag: 'QUOTING', currentOrderId: '123', lastSide: 'buy' }
 * // v5.2: lastSide теперь берётся из event.side (текущий ордер!)
 *
 * // ExecutionEvent: OrderFilled
 * state = reduce(state, {
 *   type: 'OrderFilled',
 *   orderId: '123',
 *   filledSize: 100,
 *   timestamp: new Date()
 * }, config);
 * // → { tag: 'FILLED', lastSide: 'buy' } (готов к reverse order)
 * ```
 */

import type { DumbStrategyStateData } from './DumbStrategyState.js';
import { isAllowedTransition } from './DumbStrategyState.js';
import type { StrategyEvent } from '../../events/StrategyEvent.js';
import { isExecutionEvent, isLifecycleEvent } from '../../events/StrategyEvent.js';
import type { DumbStrategyConfig } from './DumbStrategyConfig.js';

/**
 * FSM reducer - принимает StrategyEvent (ExecutionEvent | LifecycleEvent)
 *
 * @param state - Current state
 * @param event - StrategyEvent (ExecutionEvent | LifecycleEvent)
 * @param config - Strategy config (для восстановления initialSide из StrategyStarted)
 * @returns New state
 * @throws {Error} If transition not allowed (FSM violation)
 *
 * @remarks
 * КРИТИЧНО v4:
 * - StrategyEvent = Union<ExecutionEvent | LifecycleEvent>
 * - LifecycleEvent обрабатывается отдельно
 * - ExecutionEvent обрабатывается отдельно
 * - ВСЁ состояние восстанавливается из event!
 * - NO скрытых полей!
 * - FSM violation → throw (NO catch в стратегии)
 *
 * v7.7.15 Event types:
 * - LifecycleEvent: StrategyStarted, StrategyStopped
 * - ExecutionEvent: OrderAccepted, OrderCancelled, OrderRejected
 * - TickEvent: StrategyTick
 *
 * @example
 * ```typescript
 * // v4: обработка LifecycleEvent
 * const state1 = reduce(
 *   { tag: 'IDLE' },
 *   { type: 'StrategyStarted', strategyId: 'dumb-1', timestamp: new Date() },
 *   { initialSide: 'buy', ... }
 * );
 * // → { tag: 'IDLE', lastSide: 'buy' }
 *
 * // v4: обработка ExecutionEvent
 * const state2 = reduce(
 *   state1,
 *   {
 *     type: 'OrderAccepted',
 *     orderId: '123',
 *     side: 'BUY',
 *     marketId: '0xabc',
 *     price: 0.52,
 *     size: 100,
 *     timestamp: new Date()
 *   },
 *   config
 * );
 * // → { tag: 'QUOTING', currentOrderId: '123', lastSide: 'buy' }
 * ```
 */
export function reduce(
  state: DumbStrategyStateData,
  event: StrategyEvent,
  config: DumbStrategyConfig
): DumbStrategyStateData {
  // ✅ v5.5: Если стратегия уже STOPPED, игнорируем все события
  // Это terminal state - никакие события не должны менять его
  // Может произойти когда OrderCancelled приходит после остановки стратегии
  if (state.tag === 'STOPPED') {
    return state;
  }

  let newState: DumbStrategyStateData;

  // v5: обработка StrategyTick (DumbStrategy игнорирует тики)
  if (event.type === 'StrategyTick') {
    // StrategyTick не меняет state (возвращаем текущий state без изменений)
    newState = state;
  }
  // v4: обработка LifecycleEvent
  else if (isLifecycleEvent(event)) {
    switch (event.type) {
      case 'StrategyStarted':
        // v4: Первый event! Устанавливаем lastSide из config
        // Остаёмся в IDLE, но state теперь содержит lastSide
        // v6.3: Инициализируем openOrdersCount = 0
        newState = {
          tag: 'IDLE', // Остаёмся в IDLE
          lastSide: config.initialSide, // ✅ Восстановлено из config
          openOrdersCount: 0, // ✅ v6.3: Инициализируем счетчик
          positions: [], // ✅ v7.7.13: Инициализируем пустую очередь позиций
        };
        break;

      case 'StrategyStopped':
        // Переход в STOPPED state
        newState = {
          tag: 'STOPPED',
          // currentOrderId и lastSide очищаются
        };
        break;

      default: {
        const _exhaustive: never = event;
        throw new Error(`Unhandled LifecycleEvent: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
  // v4: обработка ExecutionEvent
  else if (isExecutionEvent(event)) {
    switch (event.type) {
      case 'OrderAccepted':
        // IDLE → QUOTING or FILLED → QUOTING
        // ✅ v5.2 FIX: lastSide обновляется из event.side (текущий ордер!)
        // ✅ v5.2 FIX: currentOrderPrice из event.price (для virtual fill detection)
        // ✅ v6.3: Увеличиваем openOrdersCount (ордер принят биржей!)
        newState = {
          tag: 'QUOTING',
          currentOrderId: event.orderId, // ✅ Восстановлено из event
          currentOrderPrice: event.price, // ✅ v5.2: Для virtual fill detection!
          lastSide: event.side.toLowerCase() as 'buy' | 'sell', // ✅ Из текущего ордера!
          openOrdersCount: (state.openOrdersCount || 0) + 1, // ✅ v6.3: +1 открытый ордер
          positions: state.positions, // ✅ v7.7.13: Сохраняем очередь позиций
        };
        break;

      // ✅ v7.7.15: OrderPartiallyFilled УДАЛЁН (стратегия работает только по StrategyTick)
      // ✅ v7.7.15: OrderFilled УДАЛЁН (стратегия работает только по StrategyTick)

      case 'OrderCancelled':
        // v5.4: Если isRepositioning=true, переходим в IDLE (не STOPPED)
        // чтобы можно было разместить новый ордер
        // v6.3: Уменьшаем openOrdersCount (ордер отменен)
        if (state.isRepositioning) {
          newState = {
            tag: 'IDLE',
            lastSide: state.lastSide, // Сохраняем для нового ордера
            isRepositioning: false, // Сбрасываем флаг
            openOrdersCount: Math.max(0, (state.openOrdersCount || 0) - 1), // ✅ v6.3: -1 открытый ордер
            positions: state.positions, // ✅ v7.7.13: Сохраняем очередь позиций
          };
        } else {
          // Обычная отмена → STOPPED
          newState = {
            tag: 'STOPPED',
            openOrdersCount: Math.max(0, (state.openOrdersCount || 0) - 1), // ✅ v6.3: -1 открытый ордер
            positions: state.positions, // ✅ v7.7.13: Сохраняем очередь позиций
          };
        }
        break;

      case 'OrderRejected':
        // ✅ v6.0: Если ордер отклонён из FILLED state → остаёмся в FILLED для retry
        // Это позволяет retry mechanism в StrategyTick повторить попытку
        // Пример: reverse SELL ордер отклонён из-за неправильного takerAmount
        // v6.3: openOrdersCount остается прежним (ордер не был принят биржей)
        if (state.tag === 'FILLED') {
          newState = {
            tag: 'FILLED',
            lastSide: state.lastSide,
            lastFillPrice: state.lastFillPrice,
            lastFillSize: state.lastFillSize,
            openOrdersCount: state.openOrdersCount, // ✅ v6.3: Сохраняем (не изменяется)
            positions: state.positions, // ✅ v7.7.13: Сохраняем очередь позиций
          };
        } else {
          // В остальных случаях → STOPPED
          newState = {
            tag: 'STOPPED',
            openOrdersCount: state.openOrdersCount, // ✅ v6.3: Сохраняем (не изменяется)
            positions: state.positions, // ✅ v7.7.13: Сохраняем очередь позиций
          };
        }
        break;

      default: {
        const _exhaustive: never = event;
        throw new Error(`Unhandled ExecutionEvent: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } else {
    // Не должно произойти (TypeScript гарантирует exhaustiveness)
    throw new Error(`Unknown StrategyEvent type: ${JSON.stringify(event)}`);
  }

  // Check if transition is allowed
  if (!isAllowedTransition(state.tag, newState.tag)) {
    throw new Error(
      `FSM violation: transition ${state.tag} → ${newState.tag} not allowed for event ${event.type}`
    );
  }

  return newState;
}

/**
 * Create initial state
 *
 * @returns Initial IDLE state
 *
 * @remarks
 * Начальное состояние перед LifecycleEvent: StrategyStarted.
 * lastSide НЕ установлен (будет установлен при StrategyStarted).
 *
 * @example
 * ```typescript
 * const initialState = createInitialState();
 * // → { tag: 'IDLE' }
 *
 * // После StrategyStarted:
 * const state = reduce(initialState, strategyStartedEvent, config);
 * // → { tag: 'IDLE', lastSide: 'buy' }
 * ```
 */
export function createInitialState(): DumbStrategyStateData {
  return { tag: 'IDLE' };
}

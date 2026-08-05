/**
 * MarketState — discriminated union состояния рынка с FSM-переходами
 *
 * @remarks
 * Решает две задачи:
 * 1. «Невозможные состояния» (impossible states) — компилятор TypeScript гарантирует
 *    что `resolvedOutcomeIndex` существует ТОЛЬКО в состоянии RESOLVED
 * 2. Инкапсуляция FSM — правила переходов живут здесь, а не в entity
 *
 * ### Допустимые переходы:
 * ```
 * ACTIVE → CLOSED → RESOLVED
 * ```
 *
 * Прямой переход ACTIVE → RESOLVED запрещён на уровне бизнес-логики.
 *
 * @example
 * ```typescript
 * // Создание состояний
 * const active = MarketState.active();
 * const closed = MarketState.closed();
 * const resolved = MarketState.resolved(0); // YES победил
 *
 * // FSM-переходы (Result — нарушение FSM не throw, см. Этап 3 плана миграции)
 * const nextResult = MarketState.close(active);
 * if (nextResult.ok) {
 *   const finalResult = MarketState.resolve(nextResult.value, 1);
 * }
 *
 * // Type guards
 * if (isActive(state)) {
 *   // TypeScript знает: state.status === 'ACTIVE'
 * }
 * if (isResolved(state)) {
 *   // TypeScript знает: state.resolvedOutcomeIndex is 0 | 1
 *   console.log(state.resolvedOutcomeIndex);
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import {
  MarketAlreadyClosedError,
  MarketAlreadyResolvedError,
  MarketInvalidTransitionError,
} from '@polymarket/errors/market';

/**
 * OutcomeIndex — индекс исхода рынка (YES = 0, NO = 1)
 *
 * @remarks
 * Только два значения допустимы в бинарных рынках Polymarket.
 * Использование этого типа предотвращает передачу невалидного индекса.
 */
export type OutcomeIndex = 0 | 1;

/**
 * MarketState — discriminated union состояния рынка
 *
 * @remarks
 * Три взаимоисключающих состояния:
 * - ACTIVE: рынок открыт для торговли
 * - CLOSED: торговля остановлена, ожидание разрешения
 * - RESOLVED: рынок разрешён с конкретным исходом
 */
export type MarketState =
  | { readonly status: 'ACTIVE' }
  | { readonly status: 'CLOSED' }
  | { readonly status: 'RESOLVED'; readonly resolvedOutcomeIndex: OutcomeIndex };

/**
 * Неймспейс-объект для работы с состояниями рынка
 *
 * @remarks
 * Объединяет:
 * - Конструкторы состояний (active, closed, resolved)
 * - FSM-переходы (close, resolve)
 *
 * Переходы бросают конкретные ошибки при нарушении инварианта,
 * освобождая entity от знания о правилах FSM.
 *
 * @example
 * ```typescript
 * const active = MarketState.active();
 * const closed = MarketState.close(active, { marketId: 'market-abc' });
 * const resolved = MarketState.resolve(closed, 0, { marketId: 'market-abc' });
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export const MarketState = {
  /**
   * Создаёт состояние ACTIVE
   *
   * @returns MarketState со status === 'ACTIVE'
   */
  active(): MarketState {
    return Object.freeze({ status: 'ACTIVE' as const });
  },

  /**
   * Создаёт состояние CLOSED
   *
   * @returns MarketState со status === 'CLOSED'
   */
  closed(): MarketState {
    return Object.freeze({ status: 'CLOSED' as const });
  },

  /**
   * Создаёт состояние RESOLVED
   *
   * @param index - Индекс победившего исхода (0 = YES, 1 = NO)
   * @returns MarketState со status === 'RESOLVED' и resolvedOutcomeIndex
   */
  resolved(index: OutcomeIndex): MarketState {
    return Object.freeze({
      status: 'RESOLVED' as const,
      resolvedOutcomeIndex: index,
    });
  },

  /**
   * Выполняет переход ACTIVE → CLOSED
   *
   * @param state - Текущее состояние
   * @param context - Контекст для ошибки (например, marketId)
   * @returns `Result` с новым состоянием CLOSED либо ошибкой нарушения FSM
   *
   * @remarks
   * Единственный разрешённый источник нового CLOSED состояния.
   * Вся логика проверки переходов сконцентрирована здесь.
   *
   * @example
   * ```typescript
   * const result = MarketState.close(MarketState.active(), { marketId: 'market-abc' });
   * if (result.ok) {
   *   const closed = result.value;
   * }
   * ```
   */
  close(
    state: MarketState,
    context?: Record<string, unknown>,
  ): Result<MarketState, MarketAlreadyClosedError | MarketAlreadyResolvedError> {
    if (state.status === 'CLOSED') {
      return Err(new MarketAlreadyClosedError('Market is already closed', {
        context: { ...context, currentStatus: state.status },
      }));
    }
    if (state.status === 'RESOLVED') {
      return Err(new MarketAlreadyResolvedError('Cannot close a resolved market', {
        context: { ...context, currentStatus: state.status },
      }));
    }
    return Ok(MarketState.closed());
  },

  /**
   * Выполняет переход CLOSED → RESOLVED
   *
   * @param state - Текущее состояние
   * @param index - Индекс победившего исхода
   * @param context - Контекст для ошибки (например, marketId)
   * @returns `Result` с новым состоянием RESOLVED либо ошибкой нарушения FSM
   *
   * @remarks
   * Единственный разрешённый источник нового RESOLVED состояния.
   *
   * @example
   * ```typescript
   * const result = MarketState.resolve(MarketState.closed(), 0, { marketId: 'market-abc' });
   * if (result.ok) {
   *   const resolved = result.value;
   * }
   * ```
   */
  resolve(
    state: MarketState,
    index: OutcomeIndex,
    context?: Record<string, unknown>,
  ): Result<MarketState, MarketAlreadyResolvedError | MarketInvalidTransitionError> {
    if (state.status === 'RESOLVED') {
      return Err(new MarketAlreadyResolvedError('Market is already resolved', {
        context: {
          ...context,
          currentStatus: state.status,
          resolvedOutcomeIndex: (state as { resolvedOutcomeIndex: OutcomeIndex }).resolvedOutcomeIndex,
        },
      }));
    }
    if (state.status === 'ACTIVE') {
      return Err(new MarketInvalidTransitionError(
        'Cannot resolve an active market. Call close() first.',
        { context: { ...context, currentStatus: state.status } }
      ));
    }
    return Ok(MarketState.resolved(index));
  },
} as const;

/**
 * Type guard для состояния ACTIVE
 *
 * @param state - MarketState для проверки
 * @returns true если state.status === 'ACTIVE'
 *
 * @example
 * ```typescript
 * if (isActive(market.state)) {
 *   // Рынок открыт для торговли
 * }
 * ```
 */
export function isActive(state: MarketState): state is { readonly status: 'ACTIVE' } {
  return state.status === 'ACTIVE';
}

/**
 * Type guard для состояния CLOSED
 *
 * @param state - MarketState для проверки
 * @returns true если state.status === 'CLOSED'
 *
 * @example
 * ```typescript
 * if (isClosed(market.state)) {
 *   // Торговля остановлена
 * }
 * ```
 */
export function isClosed(state: MarketState): state is { readonly status: 'CLOSED' } {
  return state.status === 'CLOSED';
}

/**
 * Type guard для состояния RESOLVED
 *
 * @param state - MarketState для проверки
 * @returns true если state.status === 'RESOLVED'
 *
 * @example
 * ```typescript
 * if (isResolved(market.state)) {
 *   // TypeScript знает что state.resolvedOutcomeIndex существует
 *   console.log(state.resolvedOutcomeIndex); // 0 | 1
 * }
 * ```
 */
export function isResolved(
  state: MarketState
): state is { readonly status: 'RESOLVED'; readonly resolvedOutcomeIndex: OutcomeIndex } {
  return state.status === 'RESOLVED';
}

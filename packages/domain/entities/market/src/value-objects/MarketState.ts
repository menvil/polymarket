/**
 * MarketState — discriminated union состояния рынка
 *
 * @remarks
 * Решает проблему "невозможных состояний" (impossible states).
 * Компилятор TypeScript гарантирует:
 * - `resolvedOutcomeIndex` существует ТОЛЬКО в состоянии RESOLVED
 * - ACTIVE рынок не может иметь `resolvedOutcomeIndex`
 * - CLOSED рынок не может иметь `resolvedOutcomeIndex`
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
 * Неймспейс-объект для создания состояний рынка
 *
 * @remarks
 * Конструкторы состояний. Использует объект вместо класса
 * для лаконичности при работе с чистыми данными.
 *
 * @example
 * ```typescript
 * const state = MarketState.active();
 * const closed = MarketState.closed();
 * const resolved = MarketState.resolved(1); // NO победил
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

/**
 * Проверяет допустимость перехода между состояниями
 *
 * @param from - Исходное состояние
 * @param to - Целевой статус
 * @returns true если переход допустим
 *
 * @remarks
 * Допустимые переходы:
 * - ACTIVE → CLOSED
 * - CLOSED → RESOLVED
 *
 * Запрещённые переходы:
 * - ACTIVE → RESOLVED (нельзя пропустить CLOSED)
 * - CLOSED → CLOSED (нет смысла)
 * - RESOLVED → любое (терминальное состояние)
 *
 * @example
 * ```typescript
 * canTransition(MarketState.active(), 'CLOSED');   // → true
 * canTransition(MarketState.closed(), 'RESOLVED'); // → true
 * canTransition(MarketState.active(), 'RESOLVED'); // → false (пропуск CLOSED)
 * canTransition(MarketState.resolved(0), 'CLOSED'); // → false (терминальное)
 * ```
 */
export function canTransition(from: MarketState, to: 'CLOSED' | 'RESOLVED'): boolean {
  if (to === 'CLOSED') {
    return from.status === 'ACTIVE';
  }
  if (to === 'RESOLVED') {
    return from.status === 'CLOSED';
  }
  return false;
}

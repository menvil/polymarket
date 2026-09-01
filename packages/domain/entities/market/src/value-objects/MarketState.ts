/**
 * MarketState — подтверждённое внешнее состояние рынка + допустимые переходы
 *
 * @remarks
 * Решает две задачи:
 * 1. «Невозможные состояния» (impossible states) — компилятор TypeScript гарантирует,
 *    что `resolvedOutcomeIndex` существует ТОЛЬКО в состоянии RESOLVED;
 * 2. Инкапсуляция FSM — правила переходов живут здесь, а не в entity.
 *
 * ### Наблюдение, а не команда
 * `MarketState` отражает то, что нам **сообщила площадка**, а не то, что мы
 * ей приказали. Соответственно и переходы называются `markClosed`/`markResolved`:
 * «зафиксировать наблюдённое состояние», а не `close`/`resolve` («закрыть рынок»).
 * Мы не управляем внешним рынком и не можем его закрыть.
 *
 * ### Что это значит для ACTIVE
 * `ACTIVE` — внешне наблюдаемое состояние. Один и тот же ACTIVE-рынок может быть:
 * - до `startsAt` (опубликован, торги ещё не начались);
 * - между `startsAt` и `expiresAt` (идёт);
 * - после `expiresAt` — площадка ещё не сообщила CLOSED/RESOLVED.
 *
 * Поэтому **истечение срока не меняет состояние**: `ACTIVE → CLOSED` происходит
 * только после подтверждения от площадки. Производную фазу («истёк, но ещё ACTIVE»)
 * вычисляет `MarketTradingPolicy.getPhase()`, и она нигде не хранится.
 *
 * ### Допустимые переходы
 * ```text
 * ACTIVE → CLOSED → RESOLVED
 * ```
 * Прямой переход ACTIVE → RESOLVED запрещён: рынок, о резолюции которого мы
 * узнали раньше, чем о закрытии, сначала фиксируется как CLOSED.
 *
 * @example
 * ```typescript
 * // Создание состояний
 * const active = MarketState.active();
 * const closed = MarketState.closed();
 * const resolved = MarketState.resolved(0); // победил исход с индексом 0
 *
 * // Переходы (Result — нарушение FSM не throw, см. Этап 3 плана миграции)
 * const nextResult = MarketState.markClosed(active);
 * if (nextResult.ok) {
 *   const finalResult = MarketState.markResolved(nextResult.value, 1);
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
 * OutcomeIndex — позиция исхода в наборе исходов рынка
 *
 * @remarks
 * Только два значения допустимы в бинарной модели рынка.
 * Использование этого типа предотвращает передачу невалидного индекса.
 */
export type OutcomeIndex = 0 | 1;

/**
 * MarketState — discriminated union подтверждённого внешнего состояния рынка
 *
 * @remarks
 * Три взаимоисключающих состояния:
 * - ACTIVE: площадка публикует рынок как активный;
 * - CLOSED: площадка подтвердила остановку торгов, исход ещё не объявлен;
 * - RESOLVED: площадка объявила победивший исход.
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
 * - конструкторы состояний (`active`, `closed`, `resolved`);
 * - переходы-наблюдения (`markClosed`, `markResolved`).
 *
 * Переходы возвращают `Result` с конкретной ошибкой при нарушении инварианта,
 * освобождая entity от знания о правилах FSM.
 *
 * @example
 * ```typescript
 * const active = MarketState.active();
 * const closed = MarketState.markClosed(active, { marketId: 'market-abc' });
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export const MarketState = {
  /**
   * Создаёт состояние ACTIVE
   *
   * @returns MarketState со status === 'ACTIVE'
   *
   * @example
   * ```typescript
   * const state = MarketState.active();
   * ```
   */
  active(): MarketState {
    return Object.freeze({ status: 'ACTIVE' as const });
  },

  /**
   * Создаёт состояние CLOSED
   *
   * @returns MarketState со status === 'CLOSED'
   *
   * @example
   * ```typescript
   * const state = MarketState.closed();
   * ```
   */
  closed(): MarketState {
    return Object.freeze({ status: 'CLOSED' as const });
  },

  /**
   * Создаёт состояние RESOLVED
   *
   * @param index - Индекс победившего исхода
   * @returns MarketState со status === 'RESOLVED' и resolvedOutcomeIndex
   *
   * @example
   * ```typescript
   * const state = MarketState.resolved(0);
   * ```
   */
  resolved(index: OutcomeIndex): MarketState {
    return Object.freeze({
      status: 'RESOLVED' as const,
      resolvedOutcomeIndex: index,
    });
  },

  /**
   * Фиксирует наблюдённое закрытие рынка (ACTIVE → CLOSED)
   *
   * @param state - Текущее состояние
   * @param context - Контекст для ошибки (например, marketId)
   * @returns `Result` с новым состоянием CLOSED либо ошибкой нарушения FSM
   * @throws Ничего не бросает — нарушение FSM возвращается как `Err`
   *
   * @remarks
   * Единственный разрешённый источник нового CLOSED состояния.
   * Вызывается только тогда, когда площадка подтвердила закрытие: истечение
   * `expiresAt` само по себе основанием для перехода не является.
   *
   * Повторный вызов на уже закрытом рынке — это `Err(MarketAlreadyClosedError)`,
   * а не no-op: наблюдение «закрыт» второй раз означает рассинхрон источника,
   * и вызывающий должен это увидеть.
   *
   * @example
   * ```typescript
   * const result = MarketState.markClosed(MarketState.active(), { marketId: 'market-abc' });
   * if (result.ok) {
   *   const closed = result.value;
   * }
   * ```
   */
  markClosed(
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
   * Фиксирует наблюдённую резолюцию рынка (CLOSED → RESOLVED)
   *
   * @param state - Текущее состояние
   * @param index - Индекс победившего исхода
   * @param context - Контекст для ошибки (например, marketId)
   * @returns `Result` с новым состоянием RESOLVED либо ошибкой нарушения FSM
   * @throws Ничего не бросает — нарушение FSM возвращается как `Err`
   *
   * @remarks
   * Единственный разрешённый источник нового RESOLVED состояния.
   * Из ACTIVE напрямую перейти нельзя: сначала фиксируется факт закрытия
   * торгов, затем — объявленный исход.
   *
   * @example
   * ```typescript
   * const result = MarketState.markResolved(MarketState.closed(), 0, { marketId: 'market-abc' });
   * if (result.ok) {
   *   const resolved = result.value;
   * }
   * ```
   */
  markResolved(
    state: MarketState,
    index: OutcomeIndex,
    context?: Record<string, unknown>,
  ): Result<MarketState, MarketAlreadyResolvedError | MarketInvalidTransitionError> {
    if (state.status === 'RESOLVED') {
      return Err(new MarketAlreadyResolvedError('Market is already resolved', {
        context: {
          ...context,
          currentStatus: state.status,
          resolvedOutcomeIndex: state.resolvedOutcomeIndex,
        },
      }));
    }
    if (state.status === 'ACTIVE') {
      return Err(new MarketInvalidTransitionError(
        'Cannot resolve an active market. Observe the close first.',
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
 *   // Площадка публикует рынок как активный
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
 *   // Площадка подтвердила остановку торгов
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

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
 * ACTIVE → CLOSED        ACTIVE → RESOLVED        CLOSED → RESOLVED
 * CLOSED → CLOSED        RESOLVED(i) → RESOLVED(i)   — идемпотентно
 * ```
 *
 * `ACTIVE → RESOLVED` **разрешён**: между двумя опросами источника рынок мог
 * успеть и закрыться, и разрезолвиться. Мы не имеем права ответить «не может
 * быть RESOLVED, я лично CLOSED не видел» — площадка не обязана показывать нам
 * каждое промежуточное состояние. RESOLVED по смыслу уже влечёт окончание торгов.
 *
 * Повторное наблюдение того же состояния — не ошибка: внешние снапшоты
 * повторяются, и опрос не должен превращать каждый цикл в `Err`.
 *
 * ### Отклоняются только настоящие конфликты
 * ```text
 * RESOLVED    → CLOSED         — регрессия: терминальное состояние необратимо
 * RESOLVED(i) → RESOLVED(j≠i)  — конфликт: источник объявил другой исход
 * ```
 * Оба случая означают, что источник противоречит уже зафиксированному факту, —
 * это должен увидеть вызывающий, а не молча проглотить модель.
 *
 * @example
 * ```typescript
 * // Создание состояний
 * const active = MarketState.active();
 * const closed = MarketState.closed();
 * const resolved = MarketState.resolved(0); // победил исход с индексом 0
 *
 * // Переходы (Result — конфликт наблюдений не throw, см. Этап 3 плана миграции)
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
import { MarketAlreadyResolvedError } from '@polymarket/errors/market';

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
 * Переходы возвращают `Result` с конкретной ошибкой при конфликте наблюдений,
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
   * @returns `Result` с состоянием CLOSED либо ошибкой конфликта наблюдений
   * @throws Ничего не бросает — конфликт возвращается как `Err`
   *
   * @remarks
   * Единственный разрешённый источник нового CLOSED состояния.
   * Вызывается только тогда, когда площадка подтвердила закрытие: истечение
   * `expiresAt` само по себе основанием для перехода не является.
   *
   * Повторное наблюдение на уже закрытом рынке **идемпотентно** — возвращается
   * тот же самый объект состояния (`Ok`), а не ошибка. Источник опрашивается
   * циклически и будет отдавать CLOSED снова и снова; превращать это в `Err`
   * значит заставлять вызывающего отличать «ничего не изменилось» от настоящей
   * проблемы на каждом тике.
   *
   * Отклоняется единственный случай — `RESOLVED → CLOSED`: терминальное
   * состояние необратимо, и такое наблюдение означает регрессию источника.
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
  ): Result<MarketState, MarketAlreadyResolvedError> {
    if (state.status === 'RESOLVED') {
      return Err(new MarketAlreadyResolvedError('Cannot observe a close on a resolved market', {
        context: {
          ...context,
          currentStatus: state.status,
          resolvedOutcomeIndex: state.resolvedOutcomeIndex,
        },
      }));
    }
    // Идемпотентность: тот же объект наружу — вызывающий отличит no-op по ссылке
    if (state.status === 'CLOSED') {
      return Ok(state);
    }
    return Ok(MarketState.closed());
  },

  /**
   * Фиксирует наблюдённую резолюцию рынка (ACTIVE | CLOSED → RESOLVED)
   *
   * @param state - Текущее состояние
   * @param index - Индекс победившего исхода
   * @param context - Контекст для ошибки (например, marketId)
   * @returns `Result` с состоянием RESOLVED либо ошибкой конфликта наблюдений
   * @throws Ничего не бросает — конфликт возвращается как `Err`
   *
   * @remarks
   * Единственный разрешённый источник нового RESOLVED состояния.
   *
   * Допустим переход **и из ACTIVE**, а не только из CLOSED: между двумя
   * опросами источника рынок мог успеть закрыться и разрезолвиться, и мы просто
   * не увидели промежуточного CLOSED. Требовать «сначала покажи закрытие» значит
   * отвергать корректное внешнее наблюдение из-за собственной частоты опроса.
   *
   * Повторная резолюция **тем же** исходом идемпотентна — возвращается тот же
   * объект состояния. Резолюция **другим** исходом отклоняется: это конфликт
   * данных источника, а не рядовое повторное наблюдение.
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
  ): Result<MarketState, MarketAlreadyResolvedError> {
    if (state.status === 'RESOLVED') {
      // Идемпотентность: тот же объект наружу — вызывающий отличит no-op по ссылке
      if (state.resolvedOutcomeIndex === index) {
        return Ok(state);
      }
      return Err(new MarketAlreadyResolvedError(
        'Market is already resolved with a different outcome',
        {
          context: {
            ...context,
            currentStatus: state.status,
            resolvedOutcomeIndex: state.resolvedOutcomeIndex,
            observedOutcomeIndex: index,
          },
        }
      ));
    }
    return Ok(MarketState.resolved(index));
  },

  /**
   * Возвращает нормализованную замороженную копию состояния
   *
   * @param state - Состояние произвольного происхождения (в т.ч. изменяемый литерал)
   * @returns Эквивалентное состояние, созданное каноническими конструкторами
   *
   * @remarks
   * Нужен там, где состояние приходит извне и его нельзя хранить по ссылке:
   * `Market` нормализует `props.state` в конструкторе, а `MarketViewModel.toSnapshot()`
   * копирует состояние в снапшот. Без этого изменяемый объект, переданный в
   * `Market.create()`, оставался бы общим для entity и снапшота, и мутация одного
   * незаметно меняла бы «иммутабельный» другой.
   *
   * Конструкторы состояний уже возвращают `Object.freeze`, поэтому копия
   * дополнительной заморозки не требует.
   *
   * @example
   * ```typescript
   * const mutable = { status: 'CLOSED' as const };
   * const safe = MarketState.normalize(mutable);
   * Object.isFrozen(safe); // → true
   * ```
   */
  normalize(state: MarketState): MarketState {
    if (state.status === 'RESOLVED') return MarketState.resolved(state.resolvedOutcomeIndex);
    if (state.status === 'CLOSED') return MarketState.closed();
    return MarketState.active();
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

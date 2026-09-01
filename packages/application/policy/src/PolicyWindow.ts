/**
 * Окно применимости policy во времени.
 *
 * @remarks
 * Policy редко действует «всегда»: расписание consumer-а меняется, и переход
 * с одной policy на другую обязан быть однозначным. Окно описывает, КОГДА
 * policy имеет силу, и делает смену детерминированной.
 *
 * ### Почему интервал ПОЛУОТКРЫТЫЙ
 *
 * Границы трактуются как `effectiveFrom <= at < effectiveUntil`. Это не
 * стилистический выбор: при замкнутом с обеих сторон интервале две соседние
 * policy пересекались бы ровно в точке стыка, и в этот момент один и тот же
 * рынок подходил бы обеим. Для value-объекта это выглядит безобидно, но
 * следующий этап строит на нём владение подписками — а «двое владеют одним
 * ресурсом ровно одну миллисекунду» превращается в гонку, которую почти
 * невозможно воспроизвести.
 *
 * ```text
 * BTC-policy: effectiveUntil = 18:00
 * XRP-policy: effectiveFrom  = 18:00
 *
 * в момент 18:00:00.000 → BTC false, XRP true
 * ```
 *
 * Ровно та же конвенция, что у любого корректного интервала расписания:
 * конец предыдущего совпадает с началом следующего, и стык принадлежит
 * следующему.
 *
 * ### Почему время приходит аргументом, а не берётся из часов
 *
 * Ни одна функция этого пакета не вызывает `Date.now()`. Момент оценки —
 * параметр, потому что вызывающий спрашивает разное: runtime — «действует
 * ли policy СЕЙЧАС», планировщик подписок — «будет ли она действовать в
 * момент старта ВОТ ЭТОГО рынка», backtest — «действовала ли она в момент
 * из архива». Функция, читающая часы сама, отвечает только на первый вопрос
 * и молча ломает два остальных.
 */
import type { Timestamp } from '@polymarket/timestamp';

/**
 * Временные границы применимости policy.
 *
 * @remarks
 * Обе границы необязательны: отсутствие `effectiveFrom` означает «действует
 * с начала времён», отсутствие `effectiveUntil` — «действует бессрочно».
 * Policy без обеих границ действует всегда — это обычный случай, а не
 * вырожденный.
 */
export interface PolicyWindow {
  /** Момент, с которого policy действует (включительно). */
  readonly effectiveFrom?: Timestamp;
  /** Момент, с которого policy НЕ действует (исключительно). */
  readonly effectiveUntil?: Timestamp;
}

/**
 * Действует ли policy в указанный момент.
 *
 * @param window - Окно применимости policy
 * @param at - Момент оценки (передаётся вызывающим, см. TSDoc модуля)
 * @returns `true`, если `effectiveFrom <= at < effectiveUntil`
 * @throws Ничего не бросает
 *
 * @remarks
 * Интервал ПОЛУОТКРЫТЫЙ: начало включено, конец исключён. Отсутствующая
 * граница ограничения не накладывает.
 *
 * @example
 * ```typescript
 * const until18 = { effectiveUntil: at18 };
 * const from18 = { effectiveFrom: at18 };
 *
 * isPolicyEffectiveAt(until18, at18); // → false (конец исключён)
 * isPolicyEffectiveAt(from18, at18);  // → true  (начало включено)
 * isPolicyEffectiveAt({}, at18);      // → true  (окна нет — действует всегда)
 * ```
 */
export function isPolicyEffectiveAt(window: PolicyWindow, at: Timestamp): boolean {
  if (window.effectiveFrom !== undefined && at.isBefore(window.effectiveFrom)) {
    return false;
  }
  if (window.effectiveUntil !== undefined && at.isAfterOrEqual(window.effectiveUntil)) {
    return false;
  }
  return true;
}

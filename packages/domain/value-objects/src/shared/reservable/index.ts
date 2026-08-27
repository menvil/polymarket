/**
 * Общее для РЕЗЕРВИРУЕМЫХ остатков: пара `(available, reserved)` и перенос
 * величины между её частями.
 *
 * @remarks
 * Четвёртая широта разделения рядом с `json/`, `numeric/` и `price/`.
 * Паттерн общий для `Balance` (деньги) и `TokenBalance` (токены исхода),
 * но идентичность актива сюда НЕ входит: у `Balance` валюта живёт внутри
 * `Money`, у `TokenBalance` токен приходит отдельным полем — это разная
 * форма, и сводить её значило бы соврать об обеих.
 */
export type { ReservablePolicy } from './validateReservableAmount.js';
export { validateReservableAmount } from './validateReservableAmount.js';

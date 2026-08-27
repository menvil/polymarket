/**
 * Общее для ЧИСЛОВЫХ value objects: то, что одинаково у цен и количеств.
 *
 * @remarks
 * Третья широта разделения рядом с `json/` (все VO) и `price/` (только
 * ценовые домены). Сюда попадает понятие, которое шире одного семейства,
 * но уже, чем «любой VO»: шаг дискретной сетки осмыслен и для тика цены,
 * и для доли лота, но бессмыслен для `Side` или `OutcomeToken`.
 */
export type { GridStepPolicy } from './ValidateGridStep.js';
export { validateGridStep } from './ValidateGridStep.js';

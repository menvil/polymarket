/**
 * Общее для ВСЕХ value objects: разбор внешнего JSON и безопасная диагностика.
 *
 * @remarks
 * Про домен здесь не знает ничего — ни про цену, ни про количество, ни про
 * валюту. Это граница с внешним миром, и она у всех VO одна и та же.
 * Построение доменной ошибки сюда НЕ входит намеренно: см. докблок
 * `jsonGuards.ts`.
 */
export { safeStringify } from './safeStringify.js';
export { describeType, readField, readJsonObject } from './jsonGuards.js';
export type { FieldType, JsonFailure } from './jsonGuards.js';

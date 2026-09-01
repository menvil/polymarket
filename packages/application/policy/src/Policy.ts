/**
 * Union всех видов owner policy.
 *
 * @remarks
 * Дискриминант — `kind`. Union намеренно маленький и закрытый: каждый вид
 * policy описывает свою площадку своими селекторами, и общего «базового
 * набора фильтров» у них нет — попытка его выделить дала бы абстракцию,
 * которая ничего не выражает.
 *
 * Реестра, владельцев и ref-count здесь нет: policy — значение. Всё
 * перечисленное появится там, где возникнет физический ресурс (подписка).
 */
import type { CexPolicy } from './CexPolicy.js';
import type { PolymarketPolicy } from './PolymarketPolicy.js';

/**
 * Любая owner policy контура.
 *
 * @example
 * ```typescript
 * function describe(policy: Policy): string {
 *   // Компилятор требует разобрать оба вида — новый вид не проскочит молча
 *   switch (policy.kind) {
 *     case 'POLYMARKET': return `polymarket:${policy.family}`;
 *     case 'CEX': return `cex:${policy.exchangeIds.join(',')}`;
 *   }
 * }
 * ```
 */
export type Policy = PolymarketPolicy | CexPolicy;

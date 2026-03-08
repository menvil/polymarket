/**
 * @polymarket/result/chain — OOP-адаптер для Result
 *
 * @remarks
 * Subpath export для OOP method chaining API.
 * Используйте когда предпочитаете fluent API над функциональным стилем.
 *
 * @example
 * ```typescript
 * import { OkChain, ErrChain, toChain, R } from '@polymarket/result/chain';
 *
 * const result = OkChain(10)
 *   .map(x => x * 2)
 *   .flatMap(x => x > 5 ? OkChain(x).toResult() : ErrChain('too small').toResult())
 *   .unwrapOr(0);
 * ```
 */

export {
  ResultChain,
  OkChain,
  ErrChain,
  toChain,
  R,
} from './ResultChain.js';

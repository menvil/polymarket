/**
 * @polymarket/result/async — async-адаптер для Promise<Result>
 *
 * @remarks
 * Subpath export для async method chaining API.
 * Используйте для работы с Promise-based операциями в Railway-Oriented стиле.
 *
 * @example
 * ```typescript
 * import { AsyncResult } from '@polymarket/result/async';
 *
 * const user = await AsyncResult.from(fetchUser('123'))
 *   .mapAsync(user => enrichUserData(user))
 *   .flatMapAsync(user => validateUser(user))
 *   .unwrapOr({ id: 'guest', name: 'Guest' });
 * ```
 */

export { AsyncResultChain, AsyncResult } from './AsyncResultChain.js';

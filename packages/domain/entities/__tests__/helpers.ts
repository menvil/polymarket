/**
 * Test helpers for working with Result types
 */

import { Result } from '@polymarket/result';

/**
 * Unwraps Result<T, E> or throws if Err
 */
export function unwrap<T, E extends Error>(result: Result<T, E>): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

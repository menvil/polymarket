import { randomInt } from 'node:crypto';
import type { RunId } from '@polymarket/ids';
import { unsafeRunId } from '@polymarket/ids';

/**
 * Алфавит RunId: lowercase-латиница + цифры (36 символов).
 * @internal
 */
const RUN_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Длина генерируемого RunId.
 * @internal
 */
const RUN_ID_LENGTH = 8;

/**
 * Генерирует новый canonical RunId — human-readable random identity одного
 * runtime/process lifecycle.
 *
 * @returns Новый RunId: 8 символов `[a-z0-9]`, например `k8f3pz7q`
 *
 * @remarks
 * Единственное canonical-место генерации RunId. Вызывается ОДИН раз на запуск
 * процесса (обычно неявно — конструктором `MessageMetadataGenerator`, если
 * runId не инъецирован), поэтому performance значения не имеет.
 *
 * Использует `crypto.randomInt` (Node crypto) — равномерное распределение без
 * modulo-bias, в отличие от паттернов на `Math.random().toString(36)`.
 * Business/application код не должен собирать RunId вручную — только через
 * этот helper или инъекцию готового значения (тесты — `unsafeRunId`).
 *
 * @example
 * ```typescript
 * const runId = generateRunId(); // 'k8f3pz7q'
 * ```
 */
export function generateRunId(): RunId {
  let raw = '';
  for (let i = 0; i < RUN_ID_LENGTH; i++) {
    raw += RUN_ID_ALPHABET[randomInt(RUN_ID_ALPHABET.length)];
  }
  // Строка валидна by construction (8 символов из [a-z0-9]) — unsafe оправдан
  return unsafeRunId(raw);
}

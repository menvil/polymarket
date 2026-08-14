/**
 * RunId - идентификатор одного runtime/process lifecycle
 *
 * @remarks
 * Branded type для type safety. Идентифицирует ОДИН запуск процесса:
 * все сообщения, созданные внутри одного runtime, несут одинаковый `runId`
 * в `MessageMetadata`. Пара `(runId, sequence)` однозначно задаёт порядок
 * сообщений внутри конкретного runtime.
 *
 * Формат: ровно 8 символов из алфавита `[a-z0-9]` (human-readable random
 * component, например `k8f3pz7q`).
 *
 * Генерация нового RunId — ответственность canonical-хелпера
 * `generateRunId()` из `@polymarket/messages` (один вызов на startup,
 * Node crypto). Business/application код не должен собирать RunId вручную.
 *
 * @example
 * ```typescript
 * const runId = asRunId('k8f3pz7q')!;
 * ```
 */
export type RunId = string & { readonly __brand: 'RunId' };

/**
 * Длина RunId — ровно 8 символов
 * @internal
 */
const RUN_ID_LENGTH = 8;

/**
 * Допустимый формат RunId: ровно 8 символов `[a-z0-9]`
 * @internal
 */
const RUN_ID_PATTERN = /^[a-z0-9]{8}$/;

/**
 * Валидация и парсинг RunId
 *
 * @param raw - Строка для парсинга
 * @returns RunId или undefined если формат невалидный
 *
 * @remarks
 * Ограничения (строже общих branded-ID правил — формат фиксированный):
 * - Ровно 8 символов
 * - Только lowercase-латиница и цифры `[a-z0-9]`
 * - Без trim: пробелы по краям делают строку невалидной
 *
 * @example
 * ```typescript
 * asRunId('k8f3pz7q'); // → 'k8f3pz7q' as RunId
 * asRunId('K8F3PZ7Q'); // → undefined (uppercase запрещён)
 * asRunId('k8f3pz7');  // → undefined (7 символов)
 * asRunId(' k8f3pz7q '); // → undefined (пробелы)
 * asRunId('');         // → undefined (пустая строка)
 * ```
 */
export function asRunId(raw: string): RunId | undefined {
  if (typeof raw !== 'string' || raw.length !== RUN_ID_LENGTH) {
    return undefined;
  }
  return RUN_ID_PATTERN.test(raw) ? (raw as RunId) : undefined;
}

/**
 * Unsafe constructor - bypasses validation
 *
 * @internal
 * @param raw - Raw string (без валидации)
 * @returns RunId
 *
 * @remarks
 * Используй только если уверен что строка валидна (например, детерминированные
 * тестовые fixtures). Для external input всегда используй asRunId().
 */
/* c8 ignore next 3 */
export function unsafeRunId(raw: string): RunId {
  return raw as RunId;
}

import { validateBrandedId } from '../core/utils/validateBrandedId.js';

/**
 * MessageId - branded system identity конкретного сообщения
 *
 * @remarks
 * Branded type для type safety. Уникально идентифицирует одно сообщение
 * системы (member `MessageMetadata.messageId`, а также цели ссылок
 * `correlationId`/`causationId`).
 *
 * MessageId — прежде всего **opaque identity**: система не парсит его
 * компоненты обратно (они уже доступны отдельными полями `MessageMetadata`).
 * Human-readable формат, который производит `MessageMetadataGenerator`:
 *
 * `<runId>-<unixSeconds>-<ms>-<us>-<ns>-<sequence>`
 *
 * например `k8f3pz7q-1786668087-123-456-789-000018423`.
 *
 * Формирование MessageId — ответственность `MessageMetadataGenerator`
 * из `@polymarket/messages`; producers не собирают его вручную.
 *
 * @example
 * ```typescript
 * const messageId = asMessageId('k8f3pz7q-1786668087-123-456-789-000018423')!;
 * ```
 */
export type MessageId = string & { readonly __brand: 'MessageId' };

/**
 * Максимальная длина MessageId
 * @internal
 */
const MAX_MESSAGE_ID_LENGTH = 128;

/**
 * Валидация и парсинг MessageId
 *
 * @param raw - Строка для парсинга
 * @returns MessageId или undefined если формат невалидный
 *
 * @remarks
 * Сознательно только базовые branded-ID ограничения (identity opaque,
 * формат не парсится):
 * - Не пустая строка
 * - Максимум 128 символов
 * - Не содержит control characters (U+0000..U+001F, U+007F..U+009F)
 * - Не содержит пробелы по краям (автоматически trim)
 *
 * @example
 * ```typescript
 * asMessageId('k8f3pz7q-1786668087-123-456-789-000018423'); // → MessageId
 * asMessageId('');   // → undefined (пустая строка)
 * asMessageId('  '); // → undefined (только пробелы)
 * ```
 */
export function asMessageId(raw: string): MessageId | undefined {
  return validateBrandedId(raw, MAX_MESSAGE_ID_LENGTH) as MessageId | undefined;
}

/**
 * Unsafe constructor - bypasses validation
 *
 * @internal
 * @param raw - Raw string (без валидации)
 * @returns MessageId
 *
 * @remarks
 * Используй только если уверен что строка валидна (генератор строит
 * валидные-by-construction строки; тестовые fixtures). Для external input
 * всегда используй asMessageId().
 */
/* c8 ignore next 3 */
export function unsafeMessageId(raw: string): MessageId {
  return raw as MessageId;
}

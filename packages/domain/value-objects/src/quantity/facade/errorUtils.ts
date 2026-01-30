import { InvalidQuantityError } from '@polymarket/errors';

/**
 * Добавляет op и дополнительный контекст к InvalidQuantityError без потери данных
 *
 * @remarks
 * Мерджит контексты корректно: сохраняет все поля из исходной ошибки
 * (включая code) и добавляет новые. Не пересоздаёт ошибку с нуля.
 * extraContext разворачивается ПЕРЕД op, чтобы op всегда был авторитетным.
 *
 * @param error - Исходная ошибка
 * @param op - Название операции
 * @param extraContext - Дополнительный контекст для добавления
 * @returns Новая ошибка с объединённым контекстом
 */
export function withOperationContext(
  error: InvalidQuantityError,
  op: string,
  extraContext?: Record<string, unknown>
): InvalidQuantityError {
  return new InvalidQuantityError(error.message, {
    code: error.code,            // Сохраняем error.code
    context: {
      ...error.context,          // Сохраняем все существующие поля
      ...extraContext,           // Добавляем дополнительные поля (может быть перезаписано op)
      op                         // op всегда авторитетный (последний)
    }
  });
}

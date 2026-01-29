import { InvalidQuantityError } from '@polymarket/errors';

/**
 * Добавляет op и дополнительный контекст к InvalidQuantityError без потери данных
 *
 * @remarks
 * Мерджит контексты корректно: сохраняет все поля из исходной ошибки
 * и добавляет новые. Не пересоздаёт ошибку с нуля.
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
    context: {
      ...error.context,    // Сохраняем все существующие поля
      op,                  // Добавляем/перезаписываем op
      ...extraContext      // Добавляем дополнительные поля
    }
  });
}

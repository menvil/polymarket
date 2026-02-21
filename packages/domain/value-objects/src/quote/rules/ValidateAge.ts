import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuoteError, ErrorSource } from '@polymarket/errors';
import type { IClock } from '@polymarket/time';
import type { Quote } from '../core/Quote.js';
import { QuoteErrorReason } from '../errors/QuoteErrorReason.js';

/**
 * Проверяет свежесть котировки
 *
 * @remarks
 * Используется для обнаружения устаревших котировок, которые не должны использоваться
 * для принятия торговых решений.
 *
 * Причины устаревания котировки:
 * - Задержка в получении данных
 * - Проблемы с сетью
 * - Отсутствие обновлений от источника
 * - Кэширование без обновления
 *
 * Алгоритм:
 * 1. Получаем текущее время через IClock (dependency injection для тестирования)
 * 2. Вычисляем возраст котировки: currentTime - quote.timestampMs()
 * 3. Сравниваем возраст с максимально допустимым значением
 * 4. Возвращаем ошибку если возраст превышает maxAgeMs
 *
 * @example
 * ```typescript
 * import { LiveClock } from '@polymarket/time';
 *
 * const clock = new LiveClock();
 * const maxAgeMs = 5000; // 5 секунд
 *
 * const result = ValidateAge.check(quote, maxAgeMs, clock);
 * if (!result.ok) {
 *   console.error('Quote is too old:', result.error.message);
 *   // Ошибка содержит информацию о возрасте и максимуме
 * }
 * ```
 *
 * @example
 * ```typescript
 * // В тестах используем PaperClock для контроля времени
 * import { PaperClock } from '@polymarket/time';
 *
 * const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
 * const quote = Quote.of(bid, ask, bidSize, askSize, new Decimal(clock.now().getTime()));
 *
 * // Перематываем время вперёд на 10 секунд
 * clock.tick(10000);
 *
 * const result = ValidateAge.check(quote, 5000, clock);
 * // result.ok === false (возраст 10s > maxAge 5s)
 * ```
 */
export class ValidateAge {
  /**
   * Проверяет возраст котировки
   *
   * @param quote - Котировка для проверки
   * @param maxAgeMs - Максимально допустимый возраст в миллисекундах
   * @param clock - IClock для получения текущего времени (dependency injection)
   * @returns Result<void, InvalidQuoteError> — Ok если котировка свежая, Err если устарела
   *
   * @example
   * ```typescript
   * import { LiveClock } from '@polymarket/time';
   *
   * const clock = new LiveClock();
   * const result = ValidateAge.check(quote, 5000, clock);
   *
   * if (result.ok) {
   *   console.log('Quote is fresh');
   * } else {
   *   const { ageMs, maxAgeMs } = result.error.context || {};
   *   console.error(`Quote age ${ageMs}ms exceeds max ${maxAgeMs}ms`);
   * }
   * ```
   *
   * @remarks
   * IClock параметр позволяет:
   * - В production использовать LiveClock (реальное время)
   * - В тестах использовать PaperClock (контролируемое время)
   * - В replay использовать ReplayClock (историческое время)
   */
  public static check(
    quote: Quote,
    maxAgeMs: number,
    clock: IClock
  ): Result<void, InvalidQuoteError> {
    const currentTimeMs = clock.now().getTime();
    const quoteTimeMs = quote.timestampMs().toNumber();
    const ageMs = currentTimeMs - quoteTimeMs;

    // Reject future-dated quotes
    if (ageMs < 0) {
      return Err(
        new InvalidQuoteError(
          `Quote timestamp ${quoteTimeMs} is in the future (current: ${currentTimeMs})`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: QuoteErrorReason.INVALID_TIMESTAMP,
              ageMs,
              quoteTimestamp: quoteTimeMs,
              currentTimestamp: currentTimeMs
            }
          }
        )
      );
    }

    if (ageMs > maxAgeMs) {
      return Err(
        new InvalidQuoteError(
          `Quote age ${ageMs}ms exceeds maximum ${maxAgeMs}ms`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: QuoteErrorReason.QUOTE_TOO_OLD,
              ageMs,
              maxAgeMs,
              quoteTimestamp: quoteTimeMs,
              currentTimestamp: currentTimeMs
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}

import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import { Quote } from '../core/Quote.js';
import { QuoteErrorReason } from '../errors/QuoteErrorReason.js';
import { QuoteService } from '../facade/QuoteService.js';
import { rewrap } from '../../shared/facade/errorUtils.js';
import { ErrorSource } from '../../shared/facade/ErrorSource.js';

/**
 * Интерфейс для JSON-представления котировки
 *
 * @remarks
 * Используется для сериализации/десериализации Quote в JSON формат.
 * Все числовые значения представлены как number для совместимости с JSON.
 */
export interface QuoteJson {
  /**
   * Цена bid (может быть null для ask-only котировок)
   */
  bid: number | null;

  /**
   * Цена ask (может быть null для bid-only котировок)
   */
  ask: number | null;

  /**
   * Размер bid ордера
   */
  bidSize: number;

  /**
   * Размер ask ордера
   */
  askSize: number;

  /**
   * Временная метка в миллисекундах (Unix timestamp)
   */
  timestamp: number;
}

/**
 * QuoteSerializer - адаптер для сериализации/десериализации Quote
 *
 * @remarks
 * Предоставляет методы для преобразования Quote в JSON и обратно.
 * Использует "Never Throw" контракт - все методы возвращают Result<T, E>.
 *
 * Алгоритм:
 * 1. toJSON() - извлекает значения из Quote и формирует QuoteJson
 * 2. fromJSON() - парсит QuoteJson и создаёт Quote через QuoteService.create()
 * 3. toString() - сериализует Quote в JSON строку
 * 4. parse() - десериализует JSON строку в Quote
 *
 * @example
 * ```typescript
 * // Сериализация
 * const quote = Quote.of(Price.of(0.48), Price.of(0.52), ...);
 * const json = QuoteSerializer.toJSON(quote);
 * console.log(json); // { bid: 0.48, ask: 0.52, ... }
 *
 * const jsonString = QuoteSerializer.toString(quote);
 * console.log(jsonString); // '{"bid":0.48,"ask":0.52,...}'
 *
 * // Десериализация
 * const result = QuoteSerializer.fromJSON(json);
 * if (result.ok) {
 *   const quote = result.value;
 * }
 *
 * const parseResult = QuoteSerializer.parse(jsonString);
 * if (parseResult.ok) {
 *   const quote = parseResult.value;
 * }
 * ```
 */
export class QuoteSerializer {
  private static readonly SERVICE_NAME = 'QuoteSerializer';

  /**
   * Преобразует Quote в JSON-объект
   *
   * @param quote - Quote для сериализации
   * @returns JSON-представление котировки
   *
   * @remarks
   * Метод "Never Throw" - гарантированно не бросает исключения.
   * Извлекает числовые значения из всех компонентов Quote.
   *
   * @example
   * ```typescript
   * const quote = Quote.of(Price.of(0.48), Price.of(0.52), ...);
   * const json = QuoteSerializer.toJSON(quote);
   * console.log(json.bid); // 0.48
   * ```
   */
  public static toJSON(quote: Quote): QuoteJson {
    return {
      bid: quote.bid()?.value().toNumber() ?? null,
      ask: quote.ask()?.value().toNumber() ?? null,
      bidSize: quote.bidSize().value().toNumber(),
      askSize: quote.askSize().value().toNumber(),
      timestamp: quote.timestampMs().toNumber()
    };
  }

  /**
   * Создаёт Quote из JSON-объекта
   *
   * @param json - JSON-объект с данными котировки
   * @returns Result с Quote или InvalidQuoteError
   *
   * @remarks
   * Использует QuoteService.create() для валидации и создания Quote.
   * Проверяет корректность всех полей JSON-объекта.
   *
   * @throws Никогда не бросает исключения (контракт "Never Throw")
   *
   * @example
   * ```typescript
   * const json = { bid: 0.48, ask: 0.52, bidSize: 100, askSize: 150, timestamp: Date.now() };
   * const result = QuoteSerializer.fromJSON(json);
   *
   * if (result.ok) {
   *   const quote = result.value;
   *   console.log(quote.isTwoSided()); // true
   * } else {
   *   console.error(result.error.message);
   * }
   * ```
   */
  public static fromJSON(json: QuoteJson): Result<Quote, InvalidQuoteError> {
    const ctx = { json };

    // Валидация основных полей
    if (typeof json.bid !== 'number' && json.bid !== null) {
      return Err(
        new InvalidQuoteError('Invalid bid field in JSON', {
          context: {
            source: ErrorSource.PARSING,
            service: QuoteSerializer.SERVICE_NAME,
            op: 'fromJSON',
            reason: QuoteErrorReason.INVALID_FORMAT,
            raw: { field: 'bid', value: json.bid },
            ...ctx
          }
        })
      );
    }

    if (typeof json.ask !== 'number' && json.ask !== null) {
      return Err(
        new InvalidQuoteError('Invalid ask field in JSON', {
          context: {
            source: ErrorSource.PARSING,
            service: QuoteSerializer.SERVICE_NAME,
            op: 'fromJSON',
            reason: QuoteErrorReason.INVALID_FORMAT,
            raw: { field: 'ask', value: json.ask },
            ...ctx
          }
        })
      );
    }

    if (typeof json.bidSize !== 'number') {
      return Err(
        new InvalidQuoteError('Invalid bidSize field in JSON', {
          context: {
            source: ErrorSource.PARSING,
            service: QuoteSerializer.SERVICE_NAME,
            op: 'fromJSON',
            reason: QuoteErrorReason.INVALID_FORMAT,
            raw: { field: 'bidSize', value: json.bidSize },
            ...ctx
          }
        })
      );
    }

    if (typeof json.askSize !== 'number') {
      return Err(
        new InvalidQuoteError('Invalid askSize field in JSON', {
          context: {
            source: ErrorSource.PARSING,
            service: QuoteSerializer.SERVICE_NAME,
            op: 'fromJSON',
            reason: QuoteErrorReason.INVALID_FORMAT,
            raw: { field: 'askSize', value: json.askSize },
            ...ctx
          }
        })
      );
    }

    if (typeof json.timestamp !== 'number') {
      return Err(
        new InvalidQuoteError('Invalid timestamp field in JSON', {
          context: {
            source: ErrorSource.PARSING,
            service: QuoteSerializer.SERVICE_NAME,
            op: 'fromJSON',
            reason: QuoteErrorReason.INVALID_FORMAT,
            raw: { field: 'timestamp', value: json.timestamp },
            ...ctx
          }
        })
      );
    }

    // Создаём Quote через QuoteService
    const result = QuoteService.create(
      json.bid,
      json.ask,
      json.bidSize,
      json.askSize,
      json.timestamp
    );

    if (!result.ok) {
      return Err(rewrap(QuoteSerializer.SERVICE_NAME, 'fromJSON', ctx, result.error, InvalidQuoteError));
    }

    return Ok(result.value);
  }

  /**
   * Преобразует Quote в JSON-строку
   *
   * @param quote - Quote для сериализации
   * @returns JSON-строка
   *
   * @remarks
   * Метод "Never Throw" - гарантированно не бросает исключения.
   * Использует toJSON() и JSON.stringify() для форматирования.
   *
   * @example
   * ```typescript
   * const quote = Quote.of(Price.of(0.48), Price.of(0.52), ...);
   * const jsonString = QuoteSerializer.toString(quote);
   * console.log(jsonString); // '{"bid":0.48,"ask":0.52,...}'
   * ```
   */
  public static toString(quote: Quote): string {
    return JSON.stringify(this.toJSON(quote));
  }

  /**
   * Парсит JSON-строку в Quote
   *
   * @param jsonString - JSON-строка с данными котировки
   * @returns Result с Quote или InvalidQuoteError
   *
   * @remarks
   * Парсит JSON-строку и вызывает fromJSON() для создания Quote.
   * Обрабатывает ошибки парсинга JSON.
   *
   * @throws Никогда не бросает исключения (контракт "Never Throw")
   *
   * @example
   * ```typescript
   * const jsonString = '{"bid":0.48,"ask":0.52,"bidSize":100,"askSize":150,"timestamp":1234567890}';
   * const result = QuoteSerializer.parse(jsonString);
   *
   * if (result.ok) {
   *   const quote = result.value;
   * } else {
   *   console.error(result.error.message);
   * }
   * ```
   */
  public static parse(jsonString: string): Result<Quote, InvalidQuoteError> {
    const ctx = { jsonString };

    try {
      const json = JSON.parse(jsonString);
      const result = this.fromJSON(json);

      if (!result.ok) {
        return Err(rewrap(QuoteSerializer.SERVICE_NAME, 'parse', ctx, result.error, InvalidQuoteError));
      }

      return Ok(result.value);
    } catch (error) {
      return Err(
        new InvalidQuoteError('Failed to parse JSON string', {
          context: {
            source: ErrorSource.PARSING,
            service: QuoteSerializer.SERVICE_NAME,
            op: 'parse',
            reason: QuoteErrorReason.INVALID_FORMAT,
            cause: error instanceof Error ? error.message : String(error),
            ...ctx
          }
        })
      );
    }
  }
}

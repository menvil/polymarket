import { Result, Err } from '@polymarket/result';
import { InvalidQuoteError, ErrorSource } from '@polymarket/errors';
import { Quote } from '../core/Quote.js';
import { QuoteErrorReason } from '../errors/QuoteErrorReason.js';
import { QuoteService } from '../facade/QuoteService.js';

/**
 * Безопасная сериализация в JSON с обработкой циклических ссылок
 *
 * @param value - Значение для сериализации
 * @returns JSON строка
 *
 * @remarks
 * Заменяет циклические ссылки на "[Circular]" вместо выброса исключения.
 * Используется для читаемой диагностики ошибок.
 */
function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    });
  } catch {
    return '[Unstringifiable]';
  }
}

/**
 * JSON контракт для Quote сериализации
 *
 * @remarks
 * Используется как:
 * - Контракт API (документация структуры)
 * - Return type для toJSON()
 * - Type hint при создании JSON
 *
 * При парсинге (fromJSON) НЕ полагайся на этот тип -
 * делай полную runtime валидацию с unknown!
 *
 * Все числовые значения представлены как number для совместимости с JSON.
 */
export interface QuoteJSON {
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
 * JSON сериализатор для Quote
 *
 * @remarks
 * ГРАНИЦА СИСТЕМЫ: принимает unknown, валидирует структуру.
 *
 * Отвечает за:
 * - Валидацию типов на границе (unknown → typed)
 * - Сериализацию/десериализацию JSON
 * - Читаемую диагностику через safeStringify
 *
 * Контракт:
 * - fromJSON НИКОГДА не доверяет типам, делает полную проверку
 * - toJSON ВСЕГДА возвращает валидный QuoteJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * @example
 * ```typescript
 * import { QuoteSerializer } from '@polymarket/value-objects/quote';
 *
 * // Десериализация
 * const result = QuoteSerializer.fromJSON({
 *   bid: 0.48,
 *   ask: 0.52,
 *   bidSize: 100,
 *   askSize: 150,
 *   timestamp: Date.now()
 * });
 * if (result.ok) {
 *   const quote = result.value;
 *   console.log(quote.isTwoSided()); // true
 * }
 *
 * // Сериализация
 * const json = QuoteSerializer.toJSON(quote);
 * console.log(json); // { bid: 0.48, ask: 0.52, ... }
 *
 * // String методы
 * const jsonString = QuoteSerializer.toJSONString(quote);
 * const parseResult = QuoteSerializer.fromJSONString(jsonString);
 * ```
 */
export class QuoteSerializer {
  private static readonly SERVICE_NAME = 'QuoteSerializer';

  /**
   * Сериализует Quote в JSON объект
   *
   * @param quote - Quote для сериализации
   * @returns QuoteJSON объект
   *
   * @remarks
   * Возвращает строго типизированный QuoteJSON.
   * Гарантирует что все поля присутствуют и имеют правильные типы.
   * Использует number для совместимости с JSON.
   *
   * @example
   * ```typescript
   * const quote = Quote.of(Price.of(0.48), Price.of(0.52), ...);
   * const json = QuoteSerializer.toJSON(quote);
   * console.log(json.bid); // 0.48
   * ```
   */
  public static toJSON(quote: Quote): QuoteJSON {
    return {
      bid: quote.bid()?.value().toNumber() ?? null,
      ask: quote.ask()?.value().toNumber() ?? null,
      bidSize: quote.bidSize().value().toNumber(),
      askSize: quote.askSize().value().toNumber(),
      timestamp: quote.timestampMs().toNumber()
    };
  }

  /**
   * Десериализует Quote из JSON объекта
   *
   * @param json - Неизвестный объект для парсинга (unknown)
   * @returns Result с Quote или InvalidQuoteError
   *
   * @remarks
   * **ПОЛНАЯ RUNTIME ВАЛИДАЦИЯ:**
   * 1. Проверяет что json это объект
   * 2. Проверяет наличие всех обязательных полей
   * 3. Проверяет типы всех полей
   * 4. Делегирует создание в QuoteService для бизнес-валидации
   *
   * НЕ использует type casts без проверок!
   * НЕ доверяет TypeScript types на границе системы!
   *
   * @example
   * ```typescript
   * // Валидный JSON
   * const ok = QuoteSerializer.fromJSON({
   *   bid: 0.48,
   *   ask: 0.52,
   *   bidSize: 100,
   *   askSize: 150,
   *   timestamp: Date.now()
   * });
   *
   * // Невалидные случаи (все возвращают Err)
   * QuoteSerializer.fromJSON(null);                     // не объект
   * QuoteSerializer.fromJSON({});                       // отсутствуют поля
   * QuoteSerializer.fromJSON({ bid: "0.5", ... });      // неверный тип
   * QuoteSerializer.fromJSON({ bid: 0.6, ask: 0.5, ...}); // bid > ask (бизнес-правило)
   * ```
   */
  public static fromJSON(json: unknown): Result<Quote, InvalidQuoteError> {
    const op = 'fromJSON';

    // Шаг 1: Проверка что это объект
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      return Err(
        new InvalidQuoteError(
          'Expected object, got ' + (json === null ? 'null' : Array.isArray(json) ? 'array' : typeof json),
          {
            context: {
              source: ErrorSource.PARSING,
              service: QuoteSerializer.SERVICE_NAME,
              op,
              json: safeStringify(json),
              reason: QuoteErrorReason.INVALID_FORMAT
            }
          }
        )
      );
    }

    // Шаг 2: Проверка наличия поля bid
    if (!('bid' in json)) {
      return Err(
        new InvalidQuoteError('Missing required field: bid', {
          context: {
            source: ErrorSource.PARSING,
            service: QuoteSerializer.SERVICE_NAME,
            op,
            json: safeStringify(json),
            reason: QuoteErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    // Шаг 3: Проверка наличия поля ask
    if (!('ask' in json)) {
      return Err(
        new InvalidQuoteError('Missing required field: ask', {
          context: {
            source: ErrorSource.PARSING,
            service: QuoteSerializer.SERVICE_NAME,
            op,
            json: safeStringify(json),
            reason: QuoteErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    // Шаг 4: Проверка наличия поля bidSize
    if (!('bidSize' in json)) {
      return Err(
        new InvalidQuoteError('Missing required field: bidSize', {
          context: {
            source: ErrorSource.PARSING,
            service: QuoteSerializer.SERVICE_NAME,
            op,
            json: safeStringify(json),
            reason: QuoteErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    // Шаг 5: Проверка наличия поля askSize
    if (!('askSize' in json)) {
      return Err(
        new InvalidQuoteError('Missing required field: askSize', {
          context: {
            source: ErrorSource.PARSING,
            service: QuoteSerializer.SERVICE_NAME,
            op,
            json: safeStringify(json),
            reason: QuoteErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    // Шаг 6: Проверка наличия поля timestamp
    if (!('timestamp' in json)) {
      return Err(
        new InvalidQuoteError('Missing required field: timestamp', {
          context: {
            source: ErrorSource.PARSING,
            service: QuoteSerializer.SERVICE_NAME,
            op,
            json: safeStringify(json),
            reason: QuoteErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    // Теперь безопасно извлекаем поля
    const { bid, ask, bidSize, askSize, timestamp } = json as {
      bid: unknown;
      ask: unknown;
      bidSize: unknown;
      askSize: unknown;
      timestamp: unknown;
    };

    // Шаг 7: Проверка типа bid (number | null)
    if (typeof bid !== 'number' && bid !== null) {
      return Err(
        new InvalidQuoteError(
          `Invalid type for field 'bid': expected number or null, got ${typeof bid}`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: QuoteSerializer.SERVICE_NAME,
              op,
              raw: { field: 'bid', value: String(bid), type: typeof bid },
              reason: QuoteErrorReason.INVALID_FORMAT
            }
          }
        )
      );
    }

    // Шаг 8: Проверка типа ask (number | null)
    if (typeof ask !== 'number' && ask !== null) {
      return Err(
        new InvalidQuoteError(
          `Invalid type for field 'ask': expected number or null, got ${typeof ask}`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: QuoteSerializer.SERVICE_NAME,
              op,
              raw: { field: 'ask', value: String(ask), type: typeof ask },
              reason: QuoteErrorReason.INVALID_FORMAT
            }
          }
        )
      );
    }

    // Шаг 9: Проверка типа bidSize
    if (typeof bidSize !== 'number') {
      return Err(
        new InvalidQuoteError(
          `Invalid type for field 'bidSize': expected number, got ${typeof bidSize}`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: QuoteSerializer.SERVICE_NAME,
              op,
              raw: { field: 'bidSize', value: String(bidSize), type: typeof bidSize },
              reason: QuoteErrorReason.INVALID_FORMAT
            }
          }
        )
      );
    }

    // Шаг 10: Проверка типа askSize
    if (typeof askSize !== 'number') {
      return Err(
        new InvalidQuoteError(
          `Invalid type for field 'askSize': expected number, got ${typeof askSize}`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: QuoteSerializer.SERVICE_NAME,
              op,
              raw: { field: 'askSize', value: String(askSize), type: typeof askSize },
              reason: QuoteErrorReason.INVALID_FORMAT
            }
          }
        )
      );
    }

    // Шаг 11: Проверка типа timestamp
    if (typeof timestamp !== 'number') {
      return Err(
        new InvalidQuoteError(
          `Invalid type for field 'timestamp': expected number, got ${typeof timestamp}`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: QuoteSerializer.SERVICE_NAME,
              op,
              raw: { field: 'timestamp', value: String(timestamp), type: typeof timestamp },
              reason: QuoteErrorReason.INVALID_FORMAT
            }
          }
        )
      );
    }

    // Шаг 12: Делегируем бизнес-валидацию и создание в QuoteService
    return QuoteService.create(bid, ask, bidSize, askSize, timestamp);
  }

  /**
   * Сериализует в JSON строку
   *
   * @param quote - Quote для сериализации
   * @returns JSON строка
   *
   * @example
   * ```typescript
   * const quote = Quote.of(Price.of(0.48), Price.of(0.52), ...);
   * const jsonString = QuoteSerializer.toJSONString(quote);
   * console.log(jsonString); // '{"bid":0.48,"ask":0.52,...}'
   * ```
   */
  public static toJSONString(quote: Quote): string {
    return JSON.stringify(this.toJSON(quote));
  }

  /**
   * Десериализует из JSON строки
   *
   * @param jsonString - JSON строка
   * @returns Result с Quote или InvalidQuoteError
   *
   * @remarks
   * Парсит JSON строку и вызывает fromJSON() для валидации и создания Quote.
   * Обрабатывает ошибки парсинга JSON.
   *
   * @example
   * ```typescript
   * const jsonString = '{"bid":0.48,"ask":0.52,"bidSize":100,"askSize":150,"timestamp":1234567890}';
   * const result = QuoteSerializer.fromJSONString(jsonString);
   *
   * if (result.ok) {
   *   const quote = result.value;
   * } else {
   *   console.error(result.error.message);
   * }
   * ```
   */
  public static fromJSONString(jsonString: string): Result<Quote, InvalidQuoteError> {
    try {
      const parsed = JSON.parse(jsonString) as unknown;
      return this.fromJSON(parsed);
    } catch (error) {
      return Err(
        new InvalidQuoteError(
          `Invalid JSON string: ${error instanceof Error ? error.message : String(error)}`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: QuoteSerializer.SERVICE_NAME,
              op: 'fromJSONString',
              jsonString,
              error: error instanceof Error ? error.message : String(error),
              reason: QuoteErrorReason.INVALID_FORMAT
            }
          }
        )
      );
    }
  }
}

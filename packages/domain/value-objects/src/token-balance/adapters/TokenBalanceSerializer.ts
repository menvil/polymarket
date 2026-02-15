import { Result, Err } from '@polymarket/result';
import { ErrorSource } from '@polymarket/errors';
import { accountIdToString, parseAccountId, type VenueId } from '@polymarket/ids';
import Decimal from 'decimal.js';
import { OutcomeTokenSerializer, type OutcomeTokenJSON } from '../../outcome-token/adapters/OutcomeTokenSerializer.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { TokenBalance } from '../core/TokenBalance.js';
import { TokenBalanceService } from '../facade/TokenBalanceService.js';
import { InvalidTokenBalanceError, TokenBalanceErrorReason } from '../errors/index.js';

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
 * JSON контракт для TokenBalance сериализации
 *
 * @remarks
 * Используется как:
 * - Контракт API (документация структуры)
 * - Return type для toJSON()
 * - Type hint при создании JSON
 *
 * При парсинге (fromJSON) НЕ полагайся на этот тип -
 * делай полную runtime валидацию с unknown!
 */
export interface TokenBalanceJSON {
  /**
   * Outcome token (serialized)
   */
  token: OutcomeTokenJSON;

  /**
   * Amount as string (preserves precision)
   */
  amount: string;

  /**
   * Account ID (serialized as string)
   *
   * @remarks
   * Формат зависит от kind:
   * - WALLET: wallet:<address>
   * - VENUE: venue:<venueId>:<userId>
   * - SUBACCOUNT: sub:<name>:<base>
   */
  accountId: string;

  /**
   * Venue ID (string identifier)
   */
  venueId: VenueId;
}

/**
 * JSON сериализатор для TokenBalance
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
 * - toJSON ВСЕГДА возвращает валидный TokenBalanceJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * @example
 * ```typescript
 * import { TokenBalanceSerializer } from '@polymarket/value-objects/token-balance';
 *
 * // Десериализация
 * const json = {
 *   token: {
 *     conditionRef: {
 *       kind: 'ONCHAIN',
 *       protocolId: 'POLYMARKET_CTF',
 *       chainId: 137,
 *       conditionId: '0xabc...'
 *     },
 *     outcomeKey: 'UP'
 *   },
 *   amount: '100.5'
 * };
 * const result = TokenBalanceSerializer.fromJSON(json);
 * if (result.ok) {
 *   console.log(result.value.amount().toNumber()); // 100.5
 * }
 *
 * // Сериализация
 * const balance = expectOk(TokenBalanceService.create(token, qty));
 * const serialized = TokenBalanceSerializer.toJSON(balance);
 * ```
 */
export class TokenBalanceSerializer {
  /**
   * Десериализует TokenBalance из JSON
   *
   * @remarks
   * Принимает unknown - граница валидации типов.
   * Валидирует структуру JSON перед парсингом.
   *
   * Этапы валидации:
   * 1. Проверка что json это объект
   * 2. Проверка наличия обязательных полей (token, amount)
   * 3. Делегирование OutcomeTokenSerializer.fromJSON для парсинга token
   * 4. Парсинг amount как Decimal
   * 5. Создание TokenBalance через TokenBalanceService.create
   *
   * @param json - JSON данные (unknown)
   * @param source - Источник ошибки (опционально)
   * @returns Result с TokenBalance или InvalidTokenBalanceError
   *
   * @example
   * ```typescript
   * // ✅ Валидный пример
   * TokenBalanceSerializer.fromJSON({
   *   token: { conditionRef: { kind: 'ONCHAIN', ... }, outcomeKey: 'UP' },
   *   amount: '100.5'
   * });
   *
   * // ❌ Структурные ошибки
   * TokenBalanceSerializer.fromJSON(null);                    // Err: expected object
   * TokenBalanceSerializer.fromJSON({});                      // Err: missing fields
   * TokenBalanceSerializer.fromJSON({ token: {}, amount: 'invalid' }); // Err: invalid amount
   * ```
   */
  public static fromJSON(
    json: unknown,
    source: ErrorSource = ErrorSource.PARSING
  ): Result<TokenBalance, InvalidTokenBalanceError> {
    // Проверка что это объект
    if (typeof json !== 'object' || json === null) {
      return Err(
        new InvalidTokenBalanceError(
          `Expected object, got ${typeof json}`,
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { type: typeof json, json: safeStringify(json) },
          },
          source
        )
      );
    }

    // Проверка что это не массив
    if (Array.isArray(json)) {
      return Err(
        new InvalidTokenBalanceError(
          'Expected object, got array',
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { type: 'array', json: safeStringify(json) },
          },
          source
        )
      );
    }

    const obj = json as Record<string, unknown>;

    // Проверка наличия token
    if (!('token' in obj)) {
      return Err(
        new InvalidTokenBalanceError(
          "Missing required field 'token'",
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { json: safeStringify(json) },
          },
          source
        )
      );
    }

    // Проверка наличия amount
    if (!('amount' in obj)) {
      return Err(
        new InvalidTokenBalanceError(
          "Missing required field 'amount'",
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { json: safeStringify(json) },
          },
          source
        )
      );
    }

    // Парсим token через OutcomeTokenSerializer
    const tokenResult = OutcomeTokenSerializer.fromJSON(obj.token, source);
    if (!tokenResult.ok) {
      return Err(
        new InvalidTokenBalanceError(
          `Failed to parse token: ${tokenResult.error.message}`,
          {
            reason: TokenBalanceErrorReason.INVALID_TOKEN,
            details: { json: safeStringify(json), tokenError: tokenResult.error },
          },
          source
        )
      );
    }

    // Проверка что amount это строка
    const amountValue = obj.amount;
    if (typeof amountValue !== 'string') {
      return Err(
        new InvalidTokenBalanceError(
          "Field 'amount' must be string",
          {
            reason: TokenBalanceErrorReason.INVALID_AMOUNT,
            details: { type: typeof amountValue },
          },
          source
        )
      );
    }

    // Парсим amount как Decimal
    let amountDecimal: Decimal;
    try {
      amountDecimal = new Decimal(amountValue);
    } catch (error) {
      return Err(
        new InvalidTokenBalanceError(
          `Failed to parse amount as Decimal: ${error instanceof Error ? error.message : String(error)}`,
          {
            reason: TokenBalanceErrorReason.INVALID_AMOUNT,
            details: { amount: amountValue, error: String(error) },
          },
          source
        )
      );
    }

    // Создаём Quantity
    let quantity: Quantity;
    try {
      quantity = Quantity.of(amountDecimal);
    } catch (error) {
      return Err(
        new InvalidTokenBalanceError(
          `Failed to create Quantity: ${error instanceof Error ? error.message : String(error)}`,
          {
            reason: TokenBalanceErrorReason.INVALID_AMOUNT,
            details: { amount: amountValue, error: String(error) },
          },
          source
        )
      );
    }

    // Проверка наличия accountId
    if (!('accountId' in obj)) {
      return Err(
        new InvalidTokenBalanceError(
          "Missing required field 'accountId'",
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { json: safeStringify(json) },
          },
          source
        )
      );
    }

    // Проверка что accountId это строка
    const accountIdValue = obj.accountId;
    if (typeof accountIdValue !== 'string') {
      return Err(
        new InvalidTokenBalanceError(
          "Field 'accountId' must be string",
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { type: typeof accountIdValue },
          },
          source
        )
      );
    }

    // Парсим accountId
    const accountIdParsed = parseAccountId(accountIdValue);
    if (!accountIdParsed) {
      return Err(
        new InvalidTokenBalanceError(
          `Failed to parse accountId: invalid format`,
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { accountId: accountIdValue },
          },
          source
        )
      );
    }

    // Проверка наличия venueId
    if (!('venueId' in obj)) {
      return Err(
        new InvalidTokenBalanceError(
          "Missing required field 'venueId'",
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { json: safeStringify(json) },
          },
          source
        )
      );
    }

    // Проверка что venueId это строка
    const venueIdValue = obj.venueId;
    if (typeof venueIdValue !== 'string') {
      return Err(
        new InvalidTokenBalanceError(
          "Field 'venueId' must be string",
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { type: typeof venueIdValue },
          },
          source
        )
      );
    }

    // VenueId это branded string, просто приводим к типу
    const venueId = venueIdValue as VenueId;

    // Создаём TokenBalance через сервис
    return TokenBalanceService.create(tokenResult.value, quantity, accountIdParsed, venueId, source);
  }

  /**
   * Сериализует TokenBalance в JSON объект
   *
   * @param balance - TokenBalance для сериализации
   * @returns TokenBalanceJSON объект
   *
   * @remarks
   * Возвращает строго типизированный TokenBalanceJSON.
   * Гарантирует что все поля присутствуют и имеют правильные типы.
   *
   * Amount сериализуется как строка для сохранения точности.
   * AccountId сериализуется в строковый формат через accountIdToString().
   *
   * @example
   * ```typescript
   * import { accountIdFromWallet, KnownVenues } from '@polymarket/ids';
   *
   * const accountId = accountIdFromWallet('0x1234...').unwrap();
   * const balance = expectOk(TokenBalanceService.create(token, qty, accountId, KnownVenues.POLYMARKET));
   * const json = TokenBalanceSerializer.toJSON(balance);
   * // → {
   * //   token: { conditionRef: { kind: 'ONCHAIN', ... }, outcomeKey: 'UP' },
   * //   amount: '100.5',
   * //   accountId: 'wallet:0x1234...',
   * //   venueId: 'POLYMARKET'
   * // }
   * ```
   */
  public static toJSON(balance: TokenBalance): TokenBalanceJSON {
    return {
      token: OutcomeTokenSerializer.toJSON(balance.token()),
      amount: balance.amount().value().toString(),
      accountId: accountIdToString(balance.accountId()),
      venueId: balance.venueId(),
    };
  }
}

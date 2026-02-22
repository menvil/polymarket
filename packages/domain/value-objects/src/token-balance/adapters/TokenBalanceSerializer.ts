import { Result, Err } from '@polymarket/result';
import { ErrorSource } from '@polymarket/errors';
import { accountIdToString, parseAccountId, asVenueId, type VenueId } from '@polymarket/ids';
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
 *
 * **BREAKING CHANGE:** Заменён формат с amount на available/reserved.
 * Старый формат с полем amount больше не поддерживается.
 */
export interface TokenBalanceJSON {
  /**
   * Outcome token (serialized)
   */
  token: OutcomeTokenJSON;

  /**
   * Available amount as string (preserves precision)
   */
  available: string;

  /**
   * Reserved amount as string (preserves precision)
   */
  reserved: string;

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
 *   available: '100',
 *   reserved: '20',
 *   accountId: 'wallet:0x1234...',
 *   venueId: 'POLYMARKET'
 * };
 * const result = TokenBalanceSerializer.fromJSON(json);
 * if (result.ok) {
 *   console.log(result.value.available().toNumber()); // 100
 *   console.log(result.value.reserved().toNumber()); // 20
 *   console.log(result.value.total().toNumber()); // 120
 * }
 *
 * // Сериализация
 * const balance = expectOk(TokenBalanceService.create(token, available, reserved, accountId, venueId));
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
   * 2. Проверка наличия обязательных полей (token, available, reserved, accountId, venueId)
   * 3. Делегирование OutcomeTokenSerializer.fromJSON для парсинга token
   * 4. Парсинг available как Decimal и создание Quantity
   * 5. Парсинг reserved как Decimal и создание Quantity
   * 6. Валидация accountId через parseAccountId
   * 7. Валидация venueId через asVenueId
   * 8. Создание TokenBalance через TokenBalanceService.create
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
   *   available: '100',
   *   reserved: '20',
   *   accountId: 'wallet:0x1234...',
   *   venueId: 'POLYMARKET'
   * });
   *
   * // ❌ Структурные ошибки
   * TokenBalanceSerializer.fromJSON(null);                    // Err: expected object
   * TokenBalanceSerializer.fromJSON({});                      // Err: missing fields
   * TokenBalanceSerializer.fromJSON({ token: {}, available: 'invalid' }); // Err: invalid available
   * ```
   */
  public static fromJSON(
    json: unknown,
    source: ErrorSource = ErrorSource.PARSING
  ): Result<TokenBalance, InvalidTokenBalanceError> {
    // Проверка что это объект
    if (typeof json !== 'object' || json === null) {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
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
        InvalidTokenBalanceError.fromLegacy(
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

    // Проверка наличия всех обязательных полей
    if (!('token' in obj)) {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          "Missing required field 'token'",
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { json: safeStringify(json) },
          },
          source
        )
      );
    }

    if (!('available' in obj)) {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          "Missing required field 'available'",
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { json: safeStringify(json) },
          },
          source
        )
      );
    }

    if (!('reserved' in obj)) {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          "Missing required field 'reserved'",
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { json: safeStringify(json) },
          },
          source
        )
      );
    }

    if (!('accountId' in obj)) {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          "Missing required field 'accountId'",
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { json: safeStringify(json) },
          },
          source
        )
      );
    }

    if (!('venueId' in obj)) {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          "Missing required field 'venueId'",
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { json: safeStringify(json) },
          },
          source
        )
      );
    }

    // Проверка типов строковых полей перед парсингом
    const availableValue = obj.available;
    if (typeof availableValue !== 'string') {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          "Field 'available' must be string",
          {
            reason: TokenBalanceErrorReason.INVALID_AMOUNT,
            details: { type: typeof availableValue },
          },
          source
        )
      );
    }

    const reservedValue = obj.reserved;
    if (typeof reservedValue !== 'string') {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          "Field 'reserved' must be string",
          {
            reason: TokenBalanceErrorReason.INVALID_AMOUNT,
            details: { type: typeof reservedValue },
          },
          source
        )
      );
    }

    const accountIdValue = obj.accountId;
    if (typeof accountIdValue !== 'string') {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          "Field 'accountId' must be string",
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { type: typeof accountIdValue },
          },
          source
        )
      );
    }

    const venueIdValue = obj.venueId;
    if (typeof venueIdValue !== 'string') {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          "Field 'venueId' must be string",
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { type: typeof venueIdValue },
          },
          source
        )
      );
    }

    // Валидация accountId
    const accountIdParsed = parseAccountId(accountIdValue);
    if (!accountIdParsed) {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          `Failed to parse accountId: invalid format`,
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { accountId: accountIdValue },
          },
          source
        )
      );
    }

    // Валидация venueId
    const venueId = asVenueId(venueIdValue);
    if (!venueId) {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          "Field 'venueId' has invalid format. Must be uppercase letters, digits, underscores, 1-32 chars, not starting with digit",
          {
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            details: { venueId: venueIdValue },
          },
          source
        )
      );
    }

    // Парсим token через OutcomeTokenSerializer
    const tokenResult = OutcomeTokenSerializer.fromJSON(obj.token, source);
    if (!tokenResult.ok) {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          `Failed to parse token: ${tokenResult.error.message}`,
          {
            reason: TokenBalanceErrorReason.INVALID_TOKEN,
            details: { json: safeStringify(json), tokenError: tokenResult.error },
          },
          source
        )
      );
    }

    // Парсим available как Decimal
    let availableDecimal: Decimal;
    try {
      availableDecimal = new Decimal(availableValue);
    } catch (error) {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          `Failed to parse available as Decimal: ${error instanceof Error ? error.message : String(error)}`,
          {
            reason: TokenBalanceErrorReason.INVALID_AMOUNT,
            details: { available: availableValue, error: String(error) },
          },
          source
        )
      );
    }

    // Парсим reserved как Decimal
    let reservedDecimal: Decimal;
    try {
      reservedDecimal = new Decimal(reservedValue);
    } catch (error) {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          `Failed to parse reserved as Decimal: ${error instanceof Error ? error.message : String(error)}`,
          {
            reason: TokenBalanceErrorReason.INVALID_AMOUNT,
            details: { reserved: reservedValue, error: String(error) },
          },
          source
        )
      );
    }

    // Создаём Quantity для available
    let availableQty: Quantity;
    try {
      availableQty = Quantity.of(availableDecimal);
    } catch (error) {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          `Failed to create Quantity for available: ${error instanceof Error ? error.message : String(error)}`,
          {
            reason: TokenBalanceErrorReason.INVALID_AMOUNT,
            details: { available: availableValue, error: String(error) },
          },
          source
        )
      );
    }

    // Создаём Quantity для reserved
    let reservedQty: Quantity;
    try {
      reservedQty = Quantity.of(reservedDecimal);
    } catch (error) {
      return Err(
        InvalidTokenBalanceError.fromLegacy(
          `Failed to create Quantity for reserved: ${error instanceof Error ? error.message : String(error)}`,
          {
            reason: TokenBalanceErrorReason.INVALID_AMOUNT,
            details: { reserved: reservedValue, error: String(error) },
          },
          source
        )
      );
    }

    // Создаём TokenBalance через сервис
    return TokenBalanceService.create(tokenResult.value, availableQty, reservedQty, accountIdParsed, venueId);
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
   * Available и reserved сериализуются как строки для сохранения точности.
   * AccountId сериализуется в строковый формат через accountIdToString().
   *
   * @example
   * ```typescript
   * import { accountIdFromWallet, KnownVenues } from '@polymarket/ids';
   *
   * const accountId = accountIdFromWallet('0x1234...').unwrap();
   * const balance = expectOk(TokenBalanceService.create(
   *   token,
   *   Quantity.of(new Decimal(100)),
   *   Quantity.of(new Decimal(20)),
   *   accountId,
   *   KnownVenues.POLYMARKET
   * ));
   * const json = TokenBalanceSerializer.toJSON(balance);
   * // → {
   * //   token: { conditionRef: { kind: 'ONCHAIN', ... }, outcomeKey: 'UP' },
   * //   available: '100',
   * //   reserved: '20',
   * //   accountId: 'wallet:0x1234...',
   * //   venueId: 'POLYMARKET'
   * // }
   * ```
   */
  public static toJSON(balance: TokenBalance): TokenBalanceJSON {
    return {
      token: OutcomeTokenSerializer.toJSON(balance.token()),
      available: balance.available().value().toString(),
      reserved: balance.reserved().value().toString(),
      accountId: accountIdToString(balance.accountId()),
      venueId: balance.venueId(),
    };
  }
}

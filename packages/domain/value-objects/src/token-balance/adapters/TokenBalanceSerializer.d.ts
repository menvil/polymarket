import { Result } from '@polymarket/result';
import { ErrorSource } from '@polymarket/errors';
import { type VenueId } from '@polymarket/ids';
import { type OutcomeTokenJSON } from '../../outcome-token/adapters/OutcomeTokenSerializer.js';
import { TokenBalance } from '../core/TokenBalance.js';
import { InvalidTokenBalanceError } from '../errors/index.js';
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
export declare class TokenBalanceSerializer {
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
    static fromJSON(json: unknown, source?: ErrorSource): Result<TokenBalance, InvalidTokenBalanceError>;
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
    static toJSON(balance: TokenBalance): TokenBalanceJSON;
}
//# sourceMappingURL=TokenBalanceSerializer.d.ts.map
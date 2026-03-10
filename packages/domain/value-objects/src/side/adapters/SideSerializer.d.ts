/**
 * Serializer для Side - JSON conversion
 *
 * @remarks
 * Предоставляет методы для сериализации/десериализации Side в/из JSON.
 *
 * Для Side сериализация тривиальна (это уже string),
 * но Serializer предоставляет единообразный API для всех VO.
 *
 * @example
 * ```typescript
 * import { SideSerializer } from '@polymarket/value-objects';
 *
 * // Сериализация
 * const json = SideSerializer.toJSON('BUY'); // 'BUY'
 *
 * // Десериализация
 * const result = SideSerializer.fromJSON('SELL');
 * if (result.ok) {
 *   console.log(result.value); // 'SELL'
 * }
 * ```
 */
import type { Result } from '@polymarket/result';
import type { InvalidSideError } from '@polymarket/errors';
import type { Side } from '../core/index.js';
/**
 * Класс SideSerializer - JSON serialization
 *
 * @remarks
 * Static-only class. Не создавайте экземпляры.
 */
export declare class SideSerializer {
    /**
     * Приватный конструктор - запрещает создание экземпляров
     */
    private constructor();
    /**
     * Сериализовать Side в JSON
     *
     * @param side - Side для сериализации
     * @returns JSON представление (string)
     *
     * @remarks
     * Для Side это identity function (возвращает то же значение),
     * но метод полезен для единообразия API со сложными VO.
     *
     * @example
     * ```typescript
     * const json = SideSerializer.toJSON('BUY'); // 'BUY'
     * JSON.stringify({ side: json }); // '{"side":"BUY"}'
     * ```
     */
    static toJSON(side: Side): string;
    /**
     * Десериализовать Side из JSON
     *
     * @param json - JSON string ('BUY' или 'SELL')
     * @returns Result<Side, InvalidSideError>
     *
     * @remarks
     * Валидирует что json это валидный Side.
     * Never throws - возвращает Result.
     *
     * @example
     * ```typescript
     * const result = SideSerializer.fromJSON('BUY');
     * if (result.ok) {
     *   console.log(result.value); // 'BUY'
     * }
     *
     * const invalid = SideSerializer.fromJSON('INVALID');
     * if (!invalid.ok) {
     *   console.error(invalid.error.message);
     * }
     * ```
     */
    static fromJSON(json: string): Result<Side, InvalidSideError>;
    /**
     * Десериализовать Side из unknown значения
     *
     * @param json - Любое значение из JSON.parse()
     * @returns Result<Side, InvalidSideError>
     *
     * @remarks
     * Универсальный метод для парсинга JSON объектов.
     * Проверяет тип и валидирует значение.
     *
     * @example
     * ```typescript
     * const parsed: unknown = JSON.parse('{"side":"BUY"}');
     * const obj = parsed as { side: unknown };
     *
     * const result = SideSerializer.fromUnknown(obj.side);
     * if (result.ok) {
     *   const side: Side = result.value; // Type-safe
     * }
     * ```
     */
    static fromUnknown(json: unknown): Result<Side, InvalidSideError>;
}
//# sourceMappingURL=SideSerializer.d.ts.map
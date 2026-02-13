import { Result, Ok, Err } from '@polymarket/result';
import { ErrorSource } from '@polymarket/errors';
import Decimal from 'decimal.js';
import type { AssetId, OnChainConditionRef, OutcomeKey } from '@polymarket/ids';
import { Quantity } from '../../quantity/core/Quantity.js';
import { AssetQuantity, AssetQuantityInvariantViolation } from '../core/index.js';
import { InvalidAssetQuantityError, AssetQuantityErrorReason } from '../errors/index.js';

/**
 * Фасад для работы с AssetQuantity - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с asset quantities.
 * Оркестрирует Core + error handling.
 *
 * **Контракт "Never Throw":**
 * Методы создания/модификации ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 * Утилитарные методы (equals, isZero, isPositive) возвращают простые типы (boolean).
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - message - человекочитаемое описание
 * - context.reason - типизированная причина (AssetQuantityErrorReason)
 * - context.details - дополнительная информация для диагностики
 * - context.source - источник ошибки (ErrorSource)
 *
 * @example
 * ```typescript
 * import { AssetQuantityService } from '@polymarket/value-objects/asset-quantity';
 * import { AssetId, BinaryOutcome } from '@polymarket/ids';
 *
 * // Create USDC asset quantity
 * const usdcResult = AssetQuantityService.createUsdc(100);
 * if (usdcResult.ok) {
 *   console.log(usdcResult.value.amount().toNumber()); // 100
 *   console.log(usdcResult.value.isCurrency()); // true
 * }
 *
 * // Create outcome token asset quantity
 * const tokenResult = AssetQuantityService.createOutcomeToken(
 *   conditionRef,
 *   BinaryOutcome.UP,
 *   50
 * );
 * if (tokenResult.ok) {
 *   console.log(tokenResult.value.isOutcomeToken()); // true
 * }
 * ```
 */
export class AssetQuantityService {
  /**
   * Создать AssetQuantity из AssetId и Quantity
   *
   * @param asset - Asset identifier (Currency или OutcomeToken)
   * @param amount - Quantity актива
   * @param source - Источник ошибки (опционально)
   * @returns Result с AssetQuantity или InvalidAssetQuantityError
   *
   * @remarks
   * Никогда не бросает исключения - всегда возвращает Result.
   *
   * Возможные ошибки:
   * - INVALID_ASSET: если asset некорректен
   * - INVALID_AMOUNT: если amount некорректен
   *
   * @example
   * ```typescript
   * const assetId = AssetIdHelpers.USDC;
   * const qty = expectOk(QuantityService.create(100));
   *
   * const result = AssetQuantityService.create(assetId, qty);
   * if (!result.ok) {
   *   console.error(result.error.context?.reason);
   * }
   * ```
   */
  public static create(
    asset: AssetId,
    amount: Quantity,
    source: ErrorSource = ErrorSource.SERVICE_CALL
  ): Result<AssetQuantity, InvalidAssetQuantityError> {
    try {
      // Create AssetQuantity (may throw AssetQuantityInvariantViolation, but unlikely)
      const assetQty = AssetQuantity.of(asset, amount);

      return Ok(assetQty);
    } catch (error) {
      // Catch AssetQuantityInvariantViolation and other unexpected errors
      if (error instanceof AssetQuantityInvariantViolation) {
        return Err(
          new InvalidAssetQuantityError(
            `Failed to create AssetQuantity: ${error.message}`,
            {
              reason: error.reason || AssetQuantityErrorReason.INVALID_INPUT,
              details: { asset, amount },
            },
            source
          )
        );
      }

      // Unexpected error
      return Err(
        new InvalidAssetQuantityError(
          `Unexpected error creating AssetQuantity: ${error instanceof Error ? error.message : String(error)}`,
          {
            details: { asset, amount, error: String(error) },
          },
          source
        )
      );
    }
  }

  /**
   * Создать AssetQuantity для USDC из числа или строки
   *
   * @param amountValue - Количество USDC (number, string, Decimal)
   * @param source - Источник ошибки (опционально)
   * @returns Result с AssetQuantity для USDC или InvalidAssetQuantityError
   *
   * @remarks
   * Convenience метод для создания USDC asset quantity.
   * Парсит amount и создаёт Quantity, затем оборачивает в AssetQuantity.
   *
   * @example
   * ```typescript
   * const result = AssetQuantityService.createUsdc(100.5);
   * if (result.ok) {
   *   console.log(result.value.amount().toNumber()); // 100.5
   *   console.log(result.value.isCurrency()); // true
   * }
   * ```
   */
  public static createUsdc(
    amountValue: number | string | Decimal,
    source: ErrorSource = ErrorSource.SERVICE_CALL
  ): Result<AssetQuantity, InvalidAssetQuantityError> {
    try {
      // Parse amount as Decimal
      const amountDecimal = new Decimal(amountValue);

      // Create Quantity
      let quantity: Quantity;
      try {
        quantity = Quantity.of(amountDecimal);
      } catch (error) {
        return Err(
          new InvalidAssetQuantityError(
            `Failed to create Quantity: ${error instanceof Error ? error.message : String(error)}`,
            {
              reason: AssetQuantityErrorReason.INVALID_AMOUNT,
              details: { amountValue, error: String(error) },
            },
            source
          )
        );
      }

      // Create AssetQuantity with USDC
      const assetQty = AssetQuantity.usdc(quantity);

      return Ok(assetQty);
    } catch (error) {
      return Err(
        new InvalidAssetQuantityError(
          `Failed to parse amount as Decimal: ${error instanceof Error ? error.message : String(error)}`,
          {
            reason: AssetQuantityErrorReason.INVALID_AMOUNT,
            details: { amountValue, error: String(error) },
          },
          source
        )
      );
    }
  }

  /**
   * Создать AssetQuantity для outcome token из числа или строки
   *
   * @param conditionRef - On-chain condition reference
   * @param outcomeKey - Outcome key (UP, DOWN, etc)
   * @param amountValue - Количество токенов (number, string, Decimal)
   * @param source - Источник ошибки (опционально)
   * @returns Result с AssetQuantity для outcome token или InvalidAssetQuantityError
   *
   * @remarks
   * Convenience метод для создания outcome token asset quantity.
   * Парсит amount и создаёт Quantity, затем оборачивает в AssetQuantity.
   *
   * @example
   * ```typescript
   * const result = AssetQuantityService.createOutcomeToken(
   *   conditionRef,
   *   BinaryOutcome.UP,
   *   50.25
   * );
   * if (result.ok) {
   *   console.log(result.value.amount().toNumber()); // 50.25
   *   console.log(result.value.isOutcomeToken()); // true
   * }
   * ```
   */
  public static createOutcomeToken(
    conditionRef: OnChainConditionRef,
    outcomeKey: OutcomeKey,
    amountValue: number | string | Decimal,
    source: ErrorSource = ErrorSource.SERVICE_CALL
  ): Result<AssetQuantity, InvalidAssetQuantityError> {
    try {
      // Parse amount as Decimal
      const amountDecimal = new Decimal(amountValue);

      // Create Quantity
      let quantity: Quantity;
      try {
        quantity = Quantity.of(amountDecimal);
      } catch (error) {
        return Err(
          new InvalidAssetQuantityError(
            `Failed to create Quantity: ${error instanceof Error ? error.message : String(error)}`,
            {
              reason: AssetQuantityErrorReason.INVALID_AMOUNT,
              details: { amountValue, conditionRef, outcomeKey, error: String(error) },
            },
            source
          )
        );
      }

      // Create AssetQuantity with outcome token
      const assetQty = AssetQuantity.outcomeToken(conditionRef, outcomeKey, quantity);

      return Ok(assetQty);
    } catch (error) {
      return Err(
        new InvalidAssetQuantityError(
          `Failed to parse amount as Decimal: ${error instanceof Error ? error.message : String(error)}`,
          {
            reason: AssetQuantityErrorReason.INVALID_AMOUNT,
            details: { amountValue, conditionRef, outcomeKey, error: String(error) },
          },
          source
        )
      );
    }
  }

  /**
   * Сравнить два AssetQuantity на равенство
   *
   * @param a - Первый AssetQuantity
   * @param b - Второй AssetQuantity
   * @returns true если asset quantities представляют одинаковый актив и количество
   *
   * @remarks
   * Never throws - безопасная утилита для сравнения.
   * Использует метод equals() из AssetQuantity core.
   *
   * @example
   * ```typescript
   * const qty1 = expectOk(AssetQuantityService.createUsdc(100));
   * const qty2 = expectOk(AssetQuantityService.createUsdc(100));
   *
   * const same = AssetQuantityService.equals(qty1, qty2);
   * console.log(same); // → true
   * ```
   */
  public static equals(a: AssetQuantity, b: AssetQuantity): boolean {
    return a.equals(b);
  }

  /**
   * Проверяет что количество нулевое
   *
   * @param assetQty - AssetQuantity для проверки
   * @returns true если amount равно 0
   *
   * @remarks
   * Never throws - безопасная утилита для проверки.
   * Делегирует к assetQty.isZero().
   *
   * @example
   * ```typescript
   * const zeroQty = expectOk(AssetQuantityService.createUsdc(0));
   * const isZero = AssetQuantityService.isZero(zeroQty); // true
   * ```
   */
  public static isZero(assetQty: AssetQuantity): boolean {
    return assetQty.isZero();
  }

  /**
   * Проверяет что количество положительное
   *
   * @param assetQty - AssetQuantity для проверки
   * @returns true если amount > 0
   *
   * @remarks
   * Never throws - безопасная утилита для проверки.
   * Делегирует к assetQty.isPositive().
   *
   * @example
   * ```typescript
   * const qty = expectOk(AssetQuantityService.createUsdc(100));
   * const isPositive = AssetQuantityService.isPositive(qty); // true
   * ```
   */
  public static isPositive(assetQty: AssetQuantity): boolean {
    return assetQty.isPositive();
  }
}

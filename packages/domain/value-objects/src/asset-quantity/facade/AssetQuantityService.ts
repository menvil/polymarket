import { Result, Ok, isErr } from '@polymarket/result';
import { wrapOp, InvalidAssetQuantityError, ErrorSource } from '@polymarket/errors';
import Decimal from 'decimal.js';
import type { AssetId, OnChainConditionRef, OutcomeKey } from '@polymarket/ids';
import { Quantity } from '../../quantity/core/Quantity.js';
import { QuantityService } from '../../quantity/facade/QuantityService.js';
import { AssetQuantity } from '../core/index.js';
import { AssetQuantityErrorReason } from '../errors/index.js';

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
 * - context.op - название операции (верхний уровень)
 * - context.cause - для core/math исключений: { name, message, stack? }
 * - context.source - источник ошибки (ErrorSource)
 * - context дополнительная информация (входные данные, reason если применимо, etc)
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
  private static readonly SERVICE_NAME = 'AssetQuantityService';

  /**
   * Создать AssetQuantity из AssetId и Quantity
   *
   * @param asset - Asset identifier (может быть из ненадёжного источника)
   * @param amount - Quantity актива
   * @returns Result с AssetQuantity или InvalidAssetQuantityError
   *
   * @remarks
   * Никогда не бросает исключения - всегда возвращает Result.
   *
   * **Defensive copy**: Использует fromAssetId() который пересоздаёт AssetId
   * для гарантии иммутабельности (asset может быть из parseAssetId).
   *
   * Возможные ошибки:
   * - Если AssetIdHelpers.fromOutcomeToken() бросит (для OUTCOME_TOKEN)
   *
   * @example
   * ```typescript
   * const assetId = AssetIdHelpers.USDC;
   * const qty = expectOk(QuantityService.create(100));
   *
   * const result = AssetQuantityService.create(assetId, qty);
   * if (!result.ok) {
   *   console.error(result.error.message);
   * }
   * ```
   */
  public static create(
    asset: AssetId,
    amount: Quantity
  ): Result<AssetQuantity, InvalidAssetQuantityError> {
    return wrapOp(
      AssetQuantityService.SERVICE_NAME,
      'create',
      { asset, amount },
      () => {
        // Конструктор делает defensive copy для гарантии иммутабельности
        const assetQty = new AssetQuantity(asset, amount);
        return Ok(assetQty);
      },
      InvalidAssetQuantityError
    );
  }

  /**
   * Создать AssetQuantity для USDC из числа или строки
   *
   * @param amountValue - Количество USDC (number, string, Decimal)
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
    amountValue: number | string | Decimal
  ): Result<AssetQuantity, InvalidAssetQuantityError> {
    return wrapOp(
      AssetQuantityService.SERVICE_NAME,
      'createUsdc',
      { amountValue },
      () => {
        // Используем QuantityService для парсинга и валидации (DRY, централизация)
        const quantityResult = QuantityService.create(amountValue);

        if (isErr(quantityResult)) {
          // Переупаковываем ошибку QuantityService в InvalidAssetQuantityError
          throw new InvalidAssetQuantityError(
            (ctx) => `Invalid amount for USDC: ${ctx.quantityError}`,
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: AssetQuantityErrorReason.INVALID_AMOUNT,
                amountValue,
                quantityError: quantityResult.error.message,
              },
            }
          );
        }

        // Create AssetQuantity with USDC
        const assetQty = AssetQuantity.usdc(quantityResult.value);

        return Ok(assetQty);
      },
      InvalidAssetQuantityError
    );
  }

  /**
   * Создать AssetQuantity для outcome token из числа или строки
   *
   * @param conditionRef - On-chain condition reference
   * @param outcomeKey - Outcome key (UP, DOWN, etc)
   * @param amountValue - Количество токенов (number, string, Decimal)
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
    amountValue: number | string | Decimal
  ): Result<AssetQuantity, InvalidAssetQuantityError> {
    return wrapOp(
      AssetQuantityService.SERVICE_NAME,
      'createOutcomeToken',
      { conditionRef, outcomeKey, amountValue },
      () => {
        // Используем QuantityService для парсинга и валидации (DRY, централизация)
        const quantityResult = QuantityService.create(amountValue);

        if (isErr(quantityResult)) {
          // Переупаковываем ошибку QuantityService в InvalidAssetQuantityError
          throw new InvalidAssetQuantityError(
            (ctx) => `Invalid amount for outcome token: ${ctx.quantityError}`,
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: AssetQuantityErrorReason.INVALID_AMOUNT,
                conditionRef,
                outcomeKey,
                amountValue,
                quantityError: quantityResult.error.message,
              },
            }
          );
        }

        const quantity = quantityResult.value;

        // Create AssetQuantity with outcome token
        // AssetIdHelpers.fromOutcomeToken() выполняет всю валидацию (DRY)
        // Ловим ошибки валидации и переупаковываем с информативными сообщениями
        try {
          const assetQty = AssetQuantity.outcomeToken(conditionRef, outcomeKey, quantity);
          return Ok(assetQty);
        } catch (error) {
          // AssetIdHelpers.fromOutcomeToken() бросил ошибку валидации
          // Переупаковываем её в InvalidAssetQuantityError с правильным reason
          const errorMessage = error instanceof Error ? error.message : String(error);
          throw new InvalidAssetQuantityError(
            () => errorMessage,
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: AssetQuantityErrorReason.INVALID_ASSET,
                conditionRef,
                outcomeKey,
              },
            }
          );
        }
      },
      InvalidAssetQuantityError
    );
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

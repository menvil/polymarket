/**
 * Чтение фактических балансов аккаунта Polymarket: collateral и outcome-токены.
 *
 * @remarks
 * ### Граница
 *
 * `AuthoritativeAssetBalance.quantity` — ФАКТИЧЕСКОЕ текущее владение, а не
 * кэш торгового слоя площадки. Поэтому адаптер состояния читает балансы не
 * SDK напрямую, а через {@link PolymarketAuthoritativeBalanceReader}: источник
 * балансов можно усилить (on-chain `balanceOf`, кросс-проверка) или заменить,
 * не меняя ни `PolymarketAccountVenueStateSource`, ни
 * `IAccountVenueStateSource`.
 *
 * ### Реализация по умолчанию — обновлённый CLOB-баланс
 *
 * {@link PolymarketRefreshedBalanceReader} читает через официальный
 * `updateBalanceAllowance`, а НЕ `fetchBalanceAllowance`:
 *
 * ```text
 * updateBalanceAllowance = GET /balance-allowance/update   (обновить взгляд CLOB)
 *                        → GET /balance-allowance          (прочитать его)
 * ```
 *
 * This implementation refreshes the CLOB balance cache before reading.
 * It MUST NOT silently convert transport/schema failures to zero.
 * An optional/stronger on-chain verifier can replace or wrap this reader
 * without changing IAccountVenueStateSource.
 *
 * Это обновлённый ВЗГЛЯД CLOB на баланс, а не математическое доказательство
 * on-chain владения: известен legacy-случай, когда токены завершившегося MINT
 * у аккаунта были, а CLOB-баланс их не показывал. Закрывает ли обновление
 * этот случай, проверяется live отдельно; до тех пор обновлённое чтение —
 * рабочий production-кандидат, а не утверждение «CLOB == blockchain».
 */
import type { AuthoritativeOutcomeAssetId } from '@polymarket/account-reconciliation';
import type { BalanceAllowanceResponse } from '@polymarket/bindings/clob';
import type { BaseSecureClient } from '@polymarket/client';
import type { UpdateBalanceAllowanceRequest } from '@polymarket/client/actions';
import { assetIdToString, isPolymarketCtfToken } from '@polymarket/ids';
import { Err, Ok, type Result } from '@polymarket/result';
import type { Money, Quantity } from '@polymarket/value-objects';
import {
  PolymarketAccountStateError,
  collateralFromBaseUnits,
  outcomeQuantityFromBaseUnits,
} from './polymarketAccountMapping.js';

/**
 * Источник фактических балансов одного аккаунта.
 *
 * @remarks
 * Ожидаемые отказы — `Err`, а не исключения и не ноль. Ноль допустим только
 * тогда, когда площадка корректно сообщила настоящий нулевой баланс.
 *
 * @example
 * ```typescript
 * const collateral = await reader.getCollateralBalance();
 * const yes = await reader.getOutcomeAssetBalance(yesToken);
 * ```
 */
export interface PolymarketAuthoritativeBalanceReader {
  /**
   * Текущий collateral аккаунта.
   *
   * @returns Фактическое collateral-владение либо отказ
   */
  getCollateralBalance(): Promise<Result<Money, PolymarketAccountStateError>>;

  /**
   * Текущий баланс одного outcome-токена.
   *
   * @param asset - Outcome-актив
   * @returns Фактическое количество (ноль — явно) либо отказ
   */
  getOutcomeAssetBalance(asset: AuthoritativeOutcomeAssetId): Promise<Result<Quantity, PolymarketAccountStateError>>;
}

/**
 * Запрос обновления balance-allowance в терминах адаптера.
 *
 * @remarks
 * Строковые литералы вместо enum `AssetType` SDK: от SDK пакет берёт только
 * типы, а значения enum передаёт composition root (см.
 * {@link PolymarketRefreshedBalanceReader.fromSdk}).
 */
export type PolymarketBalanceAllowanceRequest =
  | { readonly assetType: 'COLLATERAL' }
  | { readonly assetType: 'CONDITIONAL'; readonly tokenId: string };

/**
 * Узкий порт обновления balance-allowance.
 *
 * @remarks
 * В SDK 0.6.0 `updateBalanceAllowance` — action-функция
 * (`@polymarket/client/actions`), а не метод экземпляра клиента. Порт держит
 * reader независимым от конкретного клиента: в тестах — fake, в рантайме —
 * {@link PolymarketRefreshedBalanceReader.fromSdk}.
 */
export interface PolymarketBalanceAllowanceRefresher {
  /**
   * Обновляет взгляд CLOB на баланс и читает его.
   *
   * @param request - Тип актива и, для outcome-токена, его `tokenId`
   * @returns Ответ `balance-allowance` (нужен только `balance`)
   */
  updateBalanceAllowance(request: PolymarketBalanceAllowanceRequest): Promise<Pick<BalanceAllowanceResponse, 'balance'>>;
}

/**
 * Части официального SDK, нужные для {@link PolymarketRefreshedBalanceReader.fromSdk}.
 *
 * @remarks
 * Передаются composition root-ом, который загружает SDK как ESM:
 *
 * ```typescript
 * import { updateBalanceAllowance } from '@polymarket/client/actions';
 * import { AssetType } from '@polymarket/client';
 * PolymarketRefreshedBalanceReader.fromSdk(secureClient, { updateBalanceAllowance, assetTypes: AssetType });
 * ```
 *
 * Пакет сам runtime-код SDK не импортирует — так же, как и остальные его
 * контуры.
 */
export interface PolymarketBalanceAllowanceSdk {
  /** `updateBalanceAllowance` из `@polymarket/client/actions` */
  readonly updateBalanceAllowance: (
    client: BaseSecureClient,
    request: UpdateBalanceAllowanceRequest,
  ) => Promise<BalanceAllowanceResponse>;
  /** Enum `AssetType` SDK (`COLLATERAL`, `CONDITIONAL`) */
  readonly assetTypes: {
    readonly COLLATERAL: UpdateBalanceAllowanceRequest['assetType'];
    readonly CONDITIONAL: UpdateBalanceAllowanceRequest['assetType'];
  };
}

/**
 * Балансы через ОБНОВЛЁННЫЙ CLOB-взгляд официального SDK.
 *
 * @remarks
 * - collateral: `updateBalanceAllowance({ assetType: COLLATERAL })`;
 * - outcome-токен: `updateBalanceAllowance({ assetType: CONDITIONAL, tokenId })`
 *   (в SDK 0.6.0 поле запроса называется `tokenId`).
 *
 * Ответ `balance` — целое в базовых единицах (шесть знаков) и переводится в
 * `Money`/`Quantity` точно, без `number`. Отказ транспорта, схемы или
 * значения — `Err` с исходной причиной, никогда не ноль.
 *
 * @example
 * ```typescript
 * const reader = PolymarketRefreshedBalanceReader.fromSdk(secureClient, { updateBalanceAllowance, assetTypes: AssetType });
 * const collateral = await reader.getCollateralBalance();
 * ```
 */
export class PolymarketRefreshedBalanceReader implements PolymarketAuthoritativeBalanceReader {
  /**
   * @param _refresher - Порт обновления balance-allowance
   */
  constructor(private readonly _refresher: PolymarketBalanceAllowanceRefresher) {}

  /**
   * Reader поверх готового secure-клиента и action-функции SDK.
   *
   * @param client - Аутентифицированный клиент (`createSecureClient()` в composition root)
   * @param sdk - `updateBalanceAllowance` и enum `AssetType` официального SDK
   * @returns Reader, обновляющий CLOB-баланс перед каждым чтением
   *
   * @example
   * ```typescript
   * import { updateBalanceAllowance } from '@polymarket/client/actions';
   * import { AssetType } from '@polymarket/client';
   * const reader = PolymarketRefreshedBalanceReader.fromSdk(client, { updateBalanceAllowance, assetTypes: AssetType });
   * ```
   */
  public static fromSdk(client: BaseSecureClient, sdk: PolymarketBalanceAllowanceSdk): PolymarketRefreshedBalanceReader {
    return new PolymarketRefreshedBalanceReader({
      updateBalanceAllowance: (request) =>
        sdk.updateBalanceAllowance(
          client,
          request.assetType === 'COLLATERAL'
            ? { assetType: sdk.assetTypes.COLLATERAL }
            : { assetType: sdk.assetTypes.CONDITIONAL, tokenId: request.tokenId },
        ),
    });
  }

  /** {@inheritDoc PolymarketAuthoritativeBalanceReader.getCollateralBalance} */
  public async getCollateralBalance(): Promise<Result<Money, PolymarketAccountStateError>> {
    const response = await this._refresh({ assetType: 'COLLATERAL' }, 'collateral');
    if (!response.ok) return response;
    return collateralFromBaseUnits(response.value.balance);
  }

  /** {@inheritDoc PolymarketAuthoritativeBalanceReader.getOutcomeAssetBalance} */
  public async getOutcomeAssetBalance(
    asset: AuthoritativeOutcomeAssetId,
  ): Promise<Result<Quantity, PolymarketAccountStateError>> {
    if (!isPolymarketCtfToken(asset)) {
      return Err(
        new PolymarketAccountStateError(
          `asset ${assetIdToString(asset)}: only POLYMARKET_CTF_TOKEN assets have a CLOB token id`,
        ),
      );
    }
    const response = await this._refresh(
      { assetType: 'CONDITIONAL', tokenId: asset.tokenId },
      `token ${asset.tokenId}`,
    );
    if (!response.ok) return response;
    const quantity = outcomeQuantityFromBaseUnits(response.value.balance);
    if (!quantity.ok) {
      return Err(new PolymarketAccountStateError(`token ${asset.tokenId}: ${quantity.error.message}`, { cause: quantity.error }));
    }
    return quantity;
  }

  /**
   * Обновляет и читает balance-allowance, превращая отказ SDK в `Err`.
   *
   * @param request - Запрос SDK
   * @param subject - Что читается — для текста ошибки
   * @returns Ответ либо отказ с исходной причиной
   */
  private async _refresh(
    request: PolymarketBalanceAllowanceRequest,
    subject: string,
  ): Promise<Result<Pick<BalanceAllowanceResponse, 'balance'>, PolymarketAccountStateError>> {
    try {
      return Ok(await this._refresher.updateBalanceAllowance(request));
    } catch (error) {
      return Err(new PolymarketAccountStateError(`${subject}: balance refresh failed`, { cause: error }));
    }
  }
}

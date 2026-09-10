/*
 * LEGACY REFERENCE ONLY.
 *
 * Historical implementation of the trading contour, preserved for the
 * new trading runtime.
 *
 * Not built.
 * Not linted.
 * Not runnable against the current repository.
 * Do not import from production code.
 *
 * Source: packages/application/use-cases/src/services/venueTradeToFill.ts
 * Commit: abe9354e07501e87bf8a90fa53cccf6fa1b206a4
 *
 * See README.md for what was preserved and what was extracted to docs/.
 */
/**
 * venueTradeToFill — конвертация VenueTradeSnapshot → доменный Fill.
 *
 * @remarks
 * Общий маппер для `ReconcileTradesUseCase`-подобных recovery-потоков
 * (в частности `SettleTerminalOrdersUseCase.tradeToFill`):
 * - `settlementAssetId = USDC` (стандарт Polymarket);
 * - `venueId = POLYMARKET`;
 * - fee собирается из `FeeSnapshot`.
 *
 * @example
 * ```typescript
 * const fillResult = venueTradeToFill(tradeSnapshot, accountId);
 * if (fillResult.ok) await processFillUseCase.execute(fillResult.value);
 * ```
 */
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { AccountId } from '@polymarket/ids';
import { asVenueId, AssetIdHelpers } from '@polymarket/ids';
import type { VenueTradeSnapshot } from '@polymarket/ports';
import { Fill } from '@polymarket/fill';
import { AssetQuantity, Fee } from '@polymarket/value-objects';

/**
 * Конвертирует VenueTradeSnapshot в доменный Fill.
 *
 * @param snapshot - Снимок исполнения от биржи
 * @param accountId - ID аккаунта (из контекста сессии)
 * @returns Result<Fill, TradingError>
 */
export function venueTradeToFill(
  snapshot: VenueTradeSnapshot,
  accountId: AccountId,
): Result<Fill, TradingError> {
  const venueId = asVenueId('POLYMARKET');
  if (!venueId) {
    return Err(new TradingError('Cannot create POLYMARKET venueId', {}));
  }

  const feeAssetQuantity = new AssetQuantity(snapshot.fee.asset, snapshot.fee.amount);
  const fee = Fee.of(feeAssetQuantity);

  const fillResult = Fill.create({
    id: snapshot.fillId,
    orderId: snapshot.orderId,
    accountId,
    venueId,
    marketId: snapshot.marketId,
    tokenId: snapshot.asset,
    settlementAssetId: AssetIdHelpers.USDC,
    price: snapshot.price,
    size: snapshot.size,
    side: snapshot.side,
    timestamp: snapshot.executedAt,
    fee,
  });

  if (!fillResult.ok) {
    return Err(new TradingError(
      `Failed to create Fill from venue snapshot: ${fillResult.error.message}`,
      { context: { fillId: String(snapshot.fillId) } },
    ));
  }

  return Ok(fillResult.value);
}

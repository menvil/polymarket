/**
 * mapUserFillsToVenueTrades — единая точка конвертации raw `/data/trades`
 * записей в `VenueTradeSnapshot[]`, переиспользующая `FillMapper` (тот же
 * маппер, что и WS user-channel путь).
 *
 * @remarks
 * ### Почему один маппер для WS и REST:
 * REST и WS раньше использовали РАЗНЫЕ реализации разворачивания
 * `maker_orders[]` — REST безусловно разворачивал ВЕСЬ массив (включая чужие
 * maker-ордера) с собственной схемой составного fillId, WS фильтровал по
 * владению (`owner`/`maker_address`) и использовал bare fillId при
 * единственном своём ордере. Расхождение создавало два P0: (1) чужие
 * maker-ордера REST мог принять за свои (Portfolio/Ledger corruption); (2)
 * REST reconciliation того же fill получал ДРУГОЙ fillId, чем WS уже применил
 * — `IProcessedFillRepository` считал его новым, direct-fill path применял
 * его повторно (double accounting).
 *
 * `FillMapper.allFromPolymarketTradeEvent` — единственная реализация владения
 * и fillId, используемая ОБОИМИ путями. Raw REST-запись лишь нормализуется под
 * ожидаемые `FillMapper` имена полей (`match_time` → `timestamp`, статус без
 * `TRADE_STATUS_` префикса, `maker_address` инжектируется тем же способом, что
 * и `UserEventFeedAdapter._mapFillDto` — из credentials, а НЕ из ответа API:
 * server-provided top-level `maker_address` не гарантированно надёжен для
 * cross-outcome записей).
 *
 * @example
 * ```typescript
 * const snapshots = mapUserFillToVenueTradeSnapshots(rawFill, accountId, makerAddress, logger);
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { AccountId, MarketId } from '@polymarket/ids';
import type { VenueTradeSnapshot } from '@polymarket/ports';
import { FillMapper } from '@polymarket/fill';
import type { UserFillResponse } from '../rest/clients/PolymarketUserTradesRestClient.js';

const TRADE_STATUS_PREFIX = 'TRADE_STATUS_';

/**
 * Нормализует on-chain статус trade от Polymarket API.
 *
 * @param raw - Сырой статус (`TRADE_STATUS_CONFIRMED` и т.д.), опционально
 * @returns Строка без префикса `TRADE_STATUS_`, либо `undefined`
 */
function normalizeTradeStatus(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.startsWith(TRADE_STATUS_PREFIX) ? raw.slice(TRADE_STATUS_PREFIX.length) : raw;
}

/**
 * Конвертирует один сырой `/data/trades` fill в `VenueTradeSnapshot[]`.
 *
 * @param f - Сырая запись REST-ответа `/data/trades`
 * @param accountId - Наш AccountId
 * @param makerAddress - ETH-адрес нашего кошелька (для MAKER ownership match;
 *   тот же параметр, что `UserEventFeedAdapter._makerAddress`), опционально
 * @param logger - Logger для skip-диагностики (невалидная/чужая запись — не ошибка,
 *   просто пропускается, как и раньше)
 * @returns Массив `VenueTradeSnapshot` (обычно 1; несколько — MAKER trade с
 *   несколькими НАШИМИ ордерами; 0 — запись невалидна либо не наша)
 *
 * @remarks
 * `FillMapper.allFromPolymarketTradeEvent` уже реализует владение (`owner`
 * UUID / `maker_address`) и fillId-схему (bare для одного своего ордера,
 * составной `{tradeId}:{orderId}` для нескольких) — здесь эта логика НЕ
 * дублируется, только адаптация формата полей.
 */
export function mapUserFillToVenueTradeSnapshots(
  f: UserFillResponse,
  accountId: AccountId,
  makerAddress: string | undefined,
  logger: ILogger,
): VenueTradeSnapshot[] {
  const rawEvent: Record<string, unknown> = {
    id: f.id,
    taker_order_id: f.taker_order_id,
    trader_side: f.trader_side,
    market: f.market,
    asset_id: f.asset_id,
    side: f.side,
    price: f.price,
    size: f.size,
    fee_rate_bps: f.fee_rate_bps,
    status: normalizeTradeStatus(f.status),
    owner: f.owner,
    // ВСЕГДА наш собственный адрес (credentials), НЕ f.maker_address из ответа —
    // тот же принцип, что UserEventFeedAdapter._mapFillDto (см. doc файла).
    maker_address: makerAddress,
    maker_orders: f.maker_orders,
    // `match_time` — Unix-секунды ИЛИ миллисекунды (numeric string); FillMapper
    // сам определяет единицы по величине (< 1e12 → секунды).
    timestamp: f.match_time,
    transaction_hash: f.transaction_hash,
  };

  const result = FillMapper.allFromPolymarketTradeEvent(rawEvent, accountId);
  if (!result.ok) {
    logger.debug('Skipping user fill — not identifiable as ours or invalid', {
      id: f.id,
      error: result.error.message,
    });
    return [];
  }

  return result.value.map(({ fill, metadata }): VenueTradeSnapshot => ({
    fillId: fill.id,
    orderId: fill.orderId,
    accountId: fill.accountId,
    marketId: fill.marketId as MarketId,
    asset: fill.tokenId,
    side: fill.side,
    price: fill.price,
    size: fill.size,
    fee: { amount: fill.fee.quantity.amount(), asset: fill.fee.asset },
    executedAt: fill.timestamp,
    status: metadata.tradeStatus,
  }));
}

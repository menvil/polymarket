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
 * ### Fail-closed на ошибку маппинга (P0):
 * `/data/trades` с L2-аутентификацией возвращает ТОЛЬКО записи, где мы
 * участник (taker ЛИБО хотя бы один maker в matched-событии) — это не
 * публичный feed. Значит ЛЮБОЙ `Err` от `FillMapper` на такой записи (не
 * распознан наш maker_order, невалидный timestamp/asset/market, что угодно)
 * означает: эта запись — НАША, но мы не смогли её разобрать (баг маппинга/
 * schema drift), а НЕ «легитимно не наша». Раньше такая запись логировалась
 * и превращалась в `[]` — `getTrades()` возвращал `Ok` БЕЗ неё, и
 * `SettleTerminalOrdersUseCase` видел authoritative-пустой список там, где
 * fill реально был, освобождая held reservation ошибочно. Теперь любой `Err`
 * от `FillMapper` пробрасывается наружу как `Err` — вызывающий (`getTrades()`)
 * обязан провалить ВЕСЬ запрос, а не тихо потерять запись: лучше оставить
 * капитал frozen (retry на следующем прогоне), чем ошибочно освободить его.
 *
 * @example
 * ```typescript
 * const result = mapUserFillToVenueTradeSnapshots(rawFill, accountId, makerAddress);
 * if (!result.ok) throw new Error(`Failed to map user fill ${rawFill.id}: ${result.error.message}`);
 * ```
 */
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
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
 * @returns `Ok(snapshots)` (обычно 1 элемент; несколько — MAKER trade с
 *   несколькими НАШИМИ ордерами) либо `Err`, если `FillMapper` не смог
 *   разобрать/идентифицировать запись — см. doc файла (fail-closed: authoritated
 *   endpoint возвращает ТОЛЬКО наши записи, `Err` значит баг маппинга, НЕ
 *   «легитимно не наша запись»)
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
): Result<VenueTradeSnapshot[], Error> {
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
    return Err(new Error(`Failed to map authoritative user fill ${f.id}: ${result.error.message}`));
  }

  return Ok(result.value.map(({ fill, metadata }): VenueTradeSnapshot => ({
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
  })));
}

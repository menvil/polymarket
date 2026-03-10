/**
 * WsMessageMapper — маппер raw JSON → типизированные WS DTO.
 *
 * @remarks
 * Чистая функция без side-effects.
 * Не создаёт domain events — только парсит wire-формат в типизированные DTO.
 * Заменяет устаревший mapParsedToDomainEvent.ts (который создавал domain events в infrastructure).
 *
 * ### Правила маппинга:
 * - type='book' → WsOrderbookSnapshotDto
 * - type='trade' → WsTradeDto
 * - type='user_fill' → WsUserFillDto
 * - type='order_update' → WsOrderUpdateDto
 * - Остальные типы (pong, subscribed, price_change, etc.) → null
 * - Невалидные данные → null (никогда не бросает исключений)
 *
 * @example
 * ```typescript
 * const raw = JSON.parse(message);
 * const dto = parseWsMessage(raw);
 * if (dto && 'asset_id' in dto && dto.type === 'book') {
 *   await emitter.dispatchOrderbookSnapshot(dto as WsOrderbookSnapshotDto);
 * }
 * ```
 */

import type { WsOrderbookSnapshotDto } from '../dto/WsOrderbookDto.js';
import type { WsTradeDto } from '../dto/WsTradeDto.js';
import type { WsUserFillDto, WsOrderUpdateDto } from '../dto/WsUserEventDto.js';

/**
 * Объединение всех типизированных WS DTO.
 */
export type ParsedWsMessage =
  | WsOrderbookSnapshotDto
  | WsTradeDto
  | WsUserFillDto
  | WsOrderUpdateDto;

/**
 * Парсит raw JSON из Polymarket WS в типизированный DTO.
 *
 * @param raw - Распарсенный JSON из WebSocket
 * @returns Типизированный DTO или null для неизвестных/невалидных сообщений
 *
 * @remarks
 * Чистая функция — никогда не бросает исключений.
 * Возвращает null для контрольных сообщений (pong, subscribed, error, price_change).
 */
export function parseWsMessage(raw: unknown): ParsedWsMessage | null {
  if (!raw || typeof raw !== 'object') return null;

  const msg = raw as Record<string, unknown>;
  const type = msg['type'] as string | undefined;

  if (!type) return null;

  switch (type) {
    case 'book':
      return parseOrderbookSnapshot(msg);
    case 'trade':
      return parseTradeDto(msg);
    case 'user_fill':
      return parseUserFillDto(msg);
    case 'order_update':
      return parseOrderUpdateDto(msg);
    default:
      // pong, subscribed, unsubscribed, error, price_change, tick_size_change, last_trade_price
      return null;
  }
}

/**
 * Парсит orderbook snapshot DTO.
 *
 * @param msg - Raw JSON объект
 * @returns WsOrderbookSnapshotDto или null если невалидно
 */
function parseOrderbookSnapshot(msg: Record<string, unknown>): WsOrderbookSnapshotDto | null {
  const assetId = msg['asset_id'];
  const market = msg['market'];
  const bids = msg['bids'];
  const asks = msg['asks'];

  if (typeof assetId !== 'string' || assetId.length === 0) return null;
  if (typeof market !== 'string' || market.length === 0) return null;
  if (!Array.isArray(bids) || !Array.isArray(asks)) return null;

  return {
    type: 'book',
    asset_id: assetId,
    market,
    bids: bids as { price: string; size: string }[],
    asks: asks as { price: string; size: string }[],
    timestamp: typeof msg['timestamp'] === 'string' ? msg['timestamp'] : String(msg['timestamp'] ?? ''),
    hash: typeof msg['hash'] === 'string' ? msg['hash'] : undefined,
  };
}

/**
 * Парсит публичный трейд DTO.
 *
 * @param msg - Raw JSON объект
 * @returns WsTradeDto или null если невалидно
 */
function parseTradeDto(msg: Record<string, unknown>): WsTradeDto | null {
  const assetId = msg['asset_id'];
  const price = msg['price'];
  const size = msg['size'];
  const side = msg['side'];

  if (typeof assetId !== 'string' || assetId.length === 0) return null;
  if (typeof price !== 'string') return null;
  if (typeof size !== 'string') return null;
  if (side !== 'BUY' && side !== 'SELL') return null;

  return {
    type: 'trade',
    asset_id: assetId,
    price,
    size,
    side,
    timestamp: typeof msg['timestamp'] === 'string' ? msg['timestamp'] : String(msg['timestamp'] ?? ''),
  };
}

/**
 * Парсит user fill DTO.
 *
 * @param msg - Raw JSON объект
 * @returns WsUserFillDto или null если невалидно
 */
function parseUserFillDto(msg: Record<string, unknown>): WsUserFillDto | null {
  const id = msg['id'];
  const takerOrderId = msg['taker_order_id'];
  const traderSide = msg['trader_side'];
  const assetId = msg['asset_id'];

  if (typeof id !== 'string') return null;
  if (typeof takerOrderId !== 'string') return null;
  if (traderSide !== 'BUY' && traderSide !== 'SELL') return null;
  if (typeof assetId !== 'string') return null;

  const makerOrders = Array.isArray(msg['maker_orders'])
    ? (msg['maker_orders'] as Array<{ order_id: string; matched_amount: string }>)
    : [];

  const status = msg['status'];
  const validStatus = status === 'MATCHED' || status === 'UNMATCHED' || status === 'DELAYED'
    ? status
    : 'MATCHED';

  return {
    type: 'user_fill' as const,
    id,
    taker_order_id: takerOrderId,
    trader_side: traderSide,
    price: String(msg['price'] ?? ''),
    size: String(msg['size'] ?? ''),
    fee_rate_bps: String(msg['fee_rate_bps'] ?? '0'),
    status: validStatus,
    asset_id: assetId,
    maker_orders: makerOrders,
    timestamp: typeof msg['timestamp'] === 'string' ? msg['timestamp'] : String(msg['timestamp'] ?? ''),
  };
}

/**
 * Парсит order update DTO.
 *
 * @param msg - Raw JSON объект
 * @returns WsOrderUpdateDto или null если невалидно
 */
function parseOrderUpdateDto(msg: Record<string, unknown>): WsOrderUpdateDto | null {
  const orderId = msg['order_id'];
  if (typeof orderId !== 'string') return null;

  const status = msg['status'];
  const validStatuses = ['MATCHED', 'OPEN', 'CANCELED', 'DELAYED', 'UNMATCHED'] as const;
  const validStatus = validStatuses.includes(status as typeof validStatuses[number])
    ? (status as typeof validStatuses[number])
    : 'OPEN';

  return {
    type: 'order_update',
    order_id: orderId,
    status: validStatus,
    reason: typeof msg['reason'] === 'string' ? msg['reason'] : undefined,
    timestamp: typeof msg['timestamp'] === 'string' ? msg['timestamp'] : String(msg['timestamp'] ?? ''),
  };
}

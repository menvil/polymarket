/**
 * WsMessageMapper — маппер raw JSON → типизированные WS DTO.
 *
 * @remarks
 * Чистая функция без side-effects.
 * Не создаёт domain events — только парсит wire-формат в типизированные DTO.
 * Заменяет устаревший mapParsedToDomainEvent.ts (который создавал domain events в infrastructure).
 *
 * ### Правила маппинга:
 * - type='book'  → WsOrderbookSnapshotDto
 * - type='trade' + taker_order_id присутствует → WsUserFillDto (user channel fill)
 * - type='trade' + taker_order_id отсутствует  → WsTradeDto (market channel public trade)
 * - type='order' → WsOrderUpdateDto (user channel order lifecycle)
 * - Остальные типы (pong, subscribed, price_change, etc.) → null
 * - Невалидные данные → null (никогда не бросает исключений)
 *
 * ### Важно о type='trade':
 * Polymarket использует event_type "trade" как в market channel (публичные трейды),
 * так и в user channel (fills конкретного трейдера).
 * Различаются по форме пейлоада: user fill имеет поле taker_order_id.
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
 * Проверяет, является ли raw payload user fill событием (user channel trade).
 *
 * @param raw - Объект для проверки
 * @returns true если payload содержит taker_order_id (признак user channel fill)
 *
 * @remarks
 * Polymarket использует `event_type: "trade"` как в market channel (публичные трейды),
 * так и в user channel (fills конкретного трейдера).
 * User fill отличается наличием поля `taker_order_id` в пейлоаде.
 *
 * @example
 * ```typescript
 * if (isUserFillPayload(raw)) {
 *   // WsUserFillDto
 * } else {
 *   // WsTradeDto
 * }
 * ```
 */
export function isUserFillPayload(raw: Record<string, unknown>): boolean {
  return typeof raw['taker_order_id'] === 'string';
}

/**
 * Парсит raw JSON из Polymarket WS в типизированный DTO.
 *
 * @param raw - Распарсенный JSON из WebSocket
 * @param channel - Опциональный канал ('market' | 'user') для ускорения disambiguation.
 *   Если задан 'user' — trade события всегда парсятся как WsUserFillDto (минуя проверку taker_order_id).
 *   Если не задан — используется форма пейлоада (наличие taker_order_id).
 * @returns Типизированный DTO или null для неизвестных/невалидных сообщений
 *
 * @remarks
 * Чистая функция — никогда не бросает исключений.
 * Возвращает null для контрольных сообщений (pong, subscribed, error, price_change).
 *
 * Для type='trade': различает market trade (WsTradeDto) и user fill (WsUserFillDto)
 * по наличию поля taker_order_id в пейлоаде (или явному параметру channel).
 */
export function parseWsMessage(raw: unknown, channel?: 'market' | 'user'): ParsedWsMessage | null {
  if (!raw || typeof raw !== 'object') return null;

  const msg = raw as Record<string, unknown>;
  const type = msg['type'] as string | undefined;

  if (!type) return null;

  switch (type) {
    case 'book':
      return parseOrderbookSnapshot(msg);
    case 'trade':
      // User channel fill — различается по наличию taker_order_id или явному channel='user'
      if (channel === 'user' || isUserFillPayload(msg)) {
        return parseUserFillDto(msg);
      }
      return parseTradeDto(msg);
    case 'order':
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

  const isValidLevel = (entry: unknown): entry is { price: string; size: string } =>
    typeof entry === 'object' && entry !== null &&
    typeof (entry as Record<string, unknown>)['price'] === 'string' &&
    typeof (entry as Record<string, unknown>)['size'] === 'string';

  return {
    type: 'book',
    asset_id: assetId,
    market,
    bids: (bids as unknown[]).filter(isValidLevel),
    asks: (asks as unknown[]).filter(isValidLevel),
    timestamp: typeof msg['timestamp'] === 'string' ? msg['timestamp'] : String(msg['timestamp'] ?? ''),
    hash: typeof msg['hash'] === 'string' ? msg['hash'] : undefined,
  };
}

/**
 * Парсит публичный трейд DTO (market channel, type='trade' без taker_order_id).
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
 * Парсит user fill DTO (user channel, type='trade' с taker_order_id).
 *
 * @param msg - Raw JSON объект
 * @returns WsUserFillDto или null если невалидно
 *
 * @remarks
 * WsUserFillDto не имеет поля type — это DTO данных, не дискриминирующий тип.
 * Вызывается только когда msg содержит taker_order_id (user channel fill).
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
    ? (msg['maker_orders'] as unknown[]).filter(
        (entry): entry is { order_id: string; matched_amount: string } =>
          typeof entry === 'object' && entry !== null &&
          typeof (entry as Record<string, unknown>)['order_id'] === 'string' &&
          typeof (entry as Record<string, unknown>)['matched_amount'] === 'string'
      )
    : [];

  // WsFillStatus: MATCHED | MINED | CONFIRMED | RETRYING | FAILED
  const status = msg['status'];
  const validStatuses = new Set(['MATCHED', 'MINED', 'CONFIRMED', 'RETRYING', 'FAILED']);
  const validStatus = typeof status === 'string' && validStatuses.has(status)
    ? (status as 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED')
    : 'MATCHED'; // по умолчанию MATCHED если неизвестный статус

  // price и size обязательны для user fill — возвращаем null если отсутствуют
  if (typeof msg['price'] !== 'string' || typeof msg['size'] !== 'string') return null;

  return {
    id,
    taker_order_id: takerOrderId,
    trader_side: traderSide,
    price: msg['price'],
    size: msg['size'],
    fee_rate_bps: String(msg['fee_rate_bps'] ?? '0'),
    status: validStatus,
    asset_id: assetId,
    maker_orders: makerOrders,
    timestamp: typeof msg['timestamp'] === 'string' ? msg['timestamp'] : String(msg['timestamp'] ?? ''),
  };
}

/**
 * Парсит order lifecycle DTO (user channel, type='order').
 *
 * @param msg - Raw JSON объект
 * @returns WsOrderUpdateDto или null если невалидно
 *
 * @remarks
 * Поле orderEventType — это поле 'type' из JSON-пейлоада WS-сообщения.
 * Например: "PLACEMENT" для подтверждения размещения ордера.
 */
function parseOrderUpdateDto(msg: Record<string, unknown>): WsOrderUpdateDto | null {
  const orderId = msg['order_id'];
  if (typeof orderId !== 'string') return null;

  // orderEventType = payload 'type' field (separate from event_type discriminant)
  const orderEventType = typeof msg['orderEventType'] === 'string'
    ? msg['orderEventType']
    : typeof msg['order_event_type'] === 'string'
      ? msg['order_event_type']
      : 'UNKNOWN';

  return {
    type: 'order',
    orderEventType,
    order_id: orderId,
    status: typeof msg['status'] === 'string' ? msg['status'] : undefined,
    reason: typeof msg['reason'] === 'string' ? msg['reason'] : undefined,
    timestamp: typeof msg['timestamp'] === 'string' ? msg['timestamp'] : String(msg['timestamp'] ?? ''),
  };
}

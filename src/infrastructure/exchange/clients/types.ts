/**
 * API типы для Polymarket REST clients
 *
 * @remarks
 * Определяет типы API responses для:
 * - Orderbook (bids/asks/levels)
 * - Orders (place/cancel/status)
 * - Balance (USDC, outcome tokens)
 * - Positions (portfolio snapshot)
 *
 * Эти типы используются Client слоем для fetch.
 * Mappers конвертируют их в Domain типы.
 *
 * @module infrastructure/exchange/clients/types
 */

/**
 * Сторона ордера (API формат)
 */
export type OrderSide = 'BUY' | 'SELL';

/**
 * Статус ордера (API формат)
 */
export type ApiOrderStatus =
  | 'PENDING'    // Ордер создан, но не отправлен на биржу
  | 'LIVE'       // Ордер активен на бирже
  | 'FILLED'     // Ордер полностью исполнен
  | 'PARTIALLY_FILLED' // Ордер частично исполнен
  | 'CANCELLED'  // Ордер отменён
  | 'REJECTED';  // Ордер отклонён биржей

/**
 * Тип актива (USDC или outcome token)
 */
export type AssetType = 'USDC' | 'OUTCOME';

/**
 * API формат уровня orderbook (bid или ask)
 *
 * @remarks
 * Представляет один уровень цены в orderbook.
 * price и size всегда строки для точности decimal.
 *
 * @example
 * ```typescript
 * const level: ApiOrderbookLevel = {
 *   price: '0.55',
 *   size: '100.5'
 * };
 * ```
 */
export interface ApiOrderbookLevel {
  /** Цена (decimal string, 0.01-0.99) */
  price: string;
  /** Размер в USDC или tokens (decimal string) */
  size: string;
}

/**
 * API формат orderbook
 *
 * @remarks
 * Полный orderbook для одного рынка.
 * Содержит bids (заявки на покупку) и asks (заявки на продажу).
 *
 * @example
 * ```typescript
 * const orderbook: ApiOrderbook = {
 *   marketId: '0x123...',
 *   bids: [
 *     { price: '0.55', size: '100' },
 *     { price: '0.54', size: '200' }
 *   ],
 *   asks: [
 *     { price: '0.56', size: '150' },
 *     { price: '0.57', size: '250' }
 *   ],
 *   timestamp: 1704067200000
 * };
 * ```
 */
export interface ApiOrderbook {
  /** ID рынка (token ID) */
  marketId: string;
  /** Bids (заявки на покупку), отсортированы по убыванию цены */
  bids: ApiOrderbookLevel[];
  /** Asks (заявки на продажу), отсортированы по возрастанию цены */
  asks: ApiOrderbookLevel[];
  /** Timestamp snapshot (миллисекунды Unix, опционально) */
  timestamp?: number | string;
}

/**
 * API формат ордера
 *
 * @remarks
 * Представляет ордер в API формате.
 * Используется в responses от CLOB API.
 *
 * @example
 * ```typescript
 * const order: ApiOrder = {
 *   orderId: 'order-123',
 *   tokenId: '0xabc...',
 *   side: 'BUY',
 *   price: '0.55',
 *   size: '100',
 *   filledSize: '50',
 *   status: 'PARTIALLY_FILLED',
 *   timestamp: 1704067200000
 * };
 * ```
 */
export interface ApiOrder {
  /** ID ордера (от биржи) */
  orderId: string;
  /** ID токена (market ID) */
  tokenId: string;
  /** Сторона (BUY/SELL) */
  side: OrderSide;
  /** Цена (decimal string, 0.01-0.99) */
  price: string;
  /** Размер в USDC (decimal string) */
  size: string;
  /** Исполненный размер (decimal string) */
  filledSize: string;
  /** Статус ордера */
  status: ApiOrderStatus;
  /** Timestamp создания (миллисекунды Unix) */
  timestamp: number;
  /** Дополнительные метаданные (опционально) */
  metadata?: Record<string, unknown>;
}

/**
 * API формат баланса
 *
 * @remarks
 * Баланс USDC или outcome tokens для адреса.
 *
 * @example
 * ```typescript
 * const balance: ApiBalance = {
 *   asset: 'USDC',
 *   assetId: '0x...',
 *   amount: '1000.50',
 *   available: '950.00',
 *   locked: '50.50'
 * };
 * ```
 */
export interface ApiBalance {
  /** Тип актива (USDC или OUTCOME) */
  asset: AssetType;
  /** ID актива (для OUTCOME = tokenId, для USDC = contract address) */
  assetId: string;
  /** Общий баланс (decimal string) */
  amount: string;
  /** Доступный баланс (decimal string) */
  available: string;
  /** Заблокированный баланс в ордерах (decimal string) */
  locked: string;
}

/**
 * API формат позиции
 *
 * @remarks
 * Открытая позиция на рынке (outcome tokens).
 *
 * @example
 * ```typescript
 * const position: ApiPosition = {
 *   marketId: '0x123...',
 *   tokenId: '0xabc...',
 *   side: 'YES',
 *   size: '100',
 *   averagePrice: '0.55',
 *   currentPrice: '0.58',
 *   unrealizedPnl: '3.00'
 * };
 * ```
 */
export interface ApiPosition {
  /** ID рынка */
  marketId: string;
  /** ID токена */
  tokenId: string;
  /** Сторона (YES/NO или BUY/SELL) */
  side: string;
  /** Размер позиции (decimal string) */
  size: string;
  /** Средняя цена входа (decimal string) */
  averagePrice: string;
  /** Текущая рыночная цена (decimal string, опционально) */
  currentPrice?: string;
  /** Нереализованный PnL (decimal string, опционально) */
  unrealizedPnl?: string;
}

/**
 * API формат portfolio snapshot
 *
 * @remarks
 * Снимок всего портфолио: балансы + позиции.
 *
 * @example
 * ```typescript
 * const portfolio: ApiPortfolioSnapshot = {
 *   timestamp: 1704067200000,
 *   balances: [
 *     { asset: 'USDC', assetId: '0x...', amount: '1000', available: '950', locked: '50' }
 *   ],
 *   positions: [
 *     { marketId: '0x123', tokenId: '0xabc', side: 'YES', size: '100', averagePrice: '0.55' }
 *   ],
 *   totalValue: '1100.00'
 * };
 * ```
 */
export interface ApiPortfolioSnapshot {
  /** Timestamp snapshot (миллисекунды Unix) */
  timestamp: number;
  /** Все балансы (USDC + outcome tokens) */
  balances: ApiBalance[];
  /** Открытые позиции */
  positions: ApiPosition[];
  /** Общая стоимость портфолио в USDC (опционально) */
  totalValue?: string;
}

/**
 * @polymarket/market — каноническая доменная сущность внешнего prediction market
 *
 * @remarks
 * Пакет владеет **единственным** каноническим представлением рынка на границе:
 *
 * ```text
 * Infrastructure   (vendor → canonical mapping)
 *   ↓
 * Domain Market    ← этот пакет
 *   ↓
 * Application
 * ```
 *
 * Внутри Domain и Application нет ни SDK-объектов, ни Gamma DTO, ни RTDS-сообщений,
 * ни `Record<string, unknown>` vendor-payload'ов. Пакет не зависит ни от V2
 * (`@polymarket/client` / `@polymarket/bindings`), ни от legacy V1.
 *
 * ### Состав
 * - **Market** — entity: identity, структура, расписание, подтверждённое состояние;
 * - **MarketTradingPolicy** — производная фаза `PRE_OPEN`/`OPEN`/`ENDED`/`CLOSED`/`RESOLVED`;
 * - **Value Objects** — `MarketState`, `MarketOutcome`, `MarketFamily`, `MarketDuration`,
 *   `CryptoUpDownSpec`, `MarketSlug`, `MarketStatus` (+ реэкспорт ID из `@polymarket/ids`);
 * - **View** — `MarketViewModel` (снапшот/JSON), `MarketParser` (обратно), типы
 *   `MarketSnapshot` (доменные типы) и `MarketJSON` (примитивы);
 * - **Errors** — живут в `@polymarket/errors/market`, реэкспортированы для удобства.
 *
 * ### Что в Market намеренно не входит
 * `liquidity`, `spread`, стакан, последняя сделка, текущая и референсная цены,
 * RTDS-подписки. Это быстро меняющиеся наблюдения, а не identity/структура рынка —
 * подробное обоснование в TSDoc `Market`.
 *
 * @example
 * ```typescript
 * import {
 *   Market,
 *   MarketState,
 *   MarketTradingPolicy,
 *   asMarketDuration,
 * } from '@polymarket/market';
 * import {
 *   KnownVenues,
 *   unsafeMarketId,
 *   unsafeInstrumentId,
 *   unsafeCryptoAssetId,
 * } from '@polymarket/ids';
 * import { TimestampService } from '@polymarket/timestamp';
 *
 * const startsAt = TimestampService.fromISO('2026-09-01T12:00:00.000Z');
 * const expiresAt = TimestampService.fromISO('2026-09-01T12:05:00.000Z');
 * if (!startsAt.ok || !expiresAt.ok) throw new Error('bad schedule');
 *
 * const created = Market.create({
 *   id: unsafeMarketId('btc-up-down-1200'),
 *   venueId: KnownVenues.POLYMARKET,
 *   question: 'Bitcoin Up or Down — 12:00 to 12:05?',
 *   startsAt: startsAt.value,
 *   expiresAt: expiresAt.value,
 *   state: MarketState.active(),
 *   outcomes: [
 *     { index: 0, label: 'Up', instrumentId: unsafeInstrumentId('7147') },
 *     { index: 1, label: 'Down', instrumentId: unsafeInstrumentId('2299') },
 *   ],
 *   family: 'CRYPTO_UP_DOWN',
 *   crypto: { asset: unsafeCryptoAssetId('btc'), duration: asMarketDuration(300_000)! },
 * });
 *
 * if (created.ok) {
 *   MarketTradingPolicy.getPhase(created.value, startsAt.value); // → 'OPEN'
 * }
 * ```
 *
 * @packageDocumentation
 */

// Entity
export { Market, type MarketProps } from './Market.js';

// Trading Policy
export { MarketTradingPolicy, type MarketPhase } from './MarketTradingPolicy.js';

// Value Objects
export {
  type MarketId,
  asMarketId,
  unsafeMarketId,
  type VenueId,
  asVenueId,
  isKnownVenue,
  KnownVenues,
  type InstrumentId,
  asInstrumentId,
  unsafeInstrumentId,
  type CryptoAssetId,
  asCryptoAssetId,
  unsafeCryptoAssetId,
  type MarketSlug,
  parseMarketSlug,
  type MarketStatus,
  MARKET_STATUS_VALUES,
  isValidMarketStatus,
  type MarketFamily,
  MARKET_FAMILY_VALUES,
  isValidMarketFamily,
  type MarketDuration,
  asMarketDuration,
  type CryptoUpDownSpec,
  type MarketOutcome,
  type OutcomeIndex,
  MarketState,
  isActive,
  isClosed,
  isResolved,
} from './value-objects/index.js';

// Errors — живут в @polymarket/errors/market, re-export для удобства
export {
  MarketValidationError,
  MarketLifecycleError,
  MarketAlreadyResolvedError,
} from '@polymarket/errors/market';

// View
export { MarketViewModel } from './view/MarketViewModel.js';
export { MarketParser } from './view/MarketParser.js';
export { type MarketSnapshot } from './view/MarketSnapshot.js';
export {
  type MarketJSON,
  type MarketOutcomeJSON,
  type MarketOutcomeIndexJSON,
  type MarketStateJSON,
  type MarketFamilyJSON,
  type MarketCryptoSpecJSON,
} from './view/MarketJSON.js';

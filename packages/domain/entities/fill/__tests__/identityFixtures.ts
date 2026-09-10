/**
 * Фикстуры для тестов сравнения фактов исполнения.
 *
 * @remarks
 * Всё строится настоящими конструкторами (`Fill.create`, service-фасады
 * value objects): сравнение опирается на `equals()` реальных VO, и
 * структурная заглушка проверяла бы не тот код.
 */
import {
  AssetIdHelpers,
  accountIdFromWallet,
  asFillId,
  asMarketId,
  asOrderId,
  asPolymarketCtfToken,
  asVenueId,
  parseAssetId,
  parseWalletAddress,
  type AccountId,
  type AssetId,
  type FillId,
  type MarketId,
  type OrderId,
  type VenueId,
} from '@polymarket/ids';
import { TimestampService, type Timestamp } from '@polymarket/timestamp';
import {
  FeeService,
  OutcomePriceService,
  QuantityService,
  type Fee,
  type OutcomePrice,
  type Quantity,
  type Side,
} from '@polymarket/value-objects';
import { Fill } from '../src/Fill.js';

/** Разворачивает `Result` фикстуры: отказ здесь — дефект самого теста. */
export function must<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!result.ok) throw new Error(`fixture failed: ${String(result.error)}`);
  return result.value as T;
}

/** Момент времени из миллисекунд. */
export function ts(ms: number): Timestamp {
  return must(TimestampService.create(ms));
}

/** Площадка по умолчанию. */
export const VENUE: VenueId = asVenueId('POLYMARKET') as VenueId;

/** Вторая площадка — для проверки, что venue входит в факт. */
export const OTHER_VENUE: VenueId = asVenueId('KALSHI') as VenueId;

/** Рынок по умолчанию. */
export const MARKET: MarketId = asMarketId('market-btc-updown') as MarketId;

/** CTF-токен исхода. */
function token(tokenId: string): AssetId {
  const asset = asPolymarketCtfToken(tokenId);
  if (asset === undefined) throw new Error('fixture failed: invalid CTF token');
  return asset;
}

/** Токен исхода UP. */
export const UP_TOKEN: AssetId = token('100000000000000000000000000000000000000000000001');

/** Токен исхода DOWN. */
export const DOWN_TOKEN: AssetId = token('200000000000000000000000000000000000000000000002');

/**
 * Актив вида `OUTCOME_TOKEN` — второй допустимый актив комиссии.
 *
 * @remarks
 * `FeeService` принимает только `CURRENCY` и `OUTCOME_TOKEN`, а поддерживаемая
 * валюта одна (USDC). Поэтому проверить, что актив комиссии входит в факт,
 * можно только парой USDC ↔ OUTCOME_TOKEN.
 */
export const OUTCOME_TOKEN_ASSET: AssetId = (() => {
  const asset = parseAssetId(`OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0x${'a'.repeat(64)}:UP`);
  if (asset === undefined) throw new Error('fixture failed: invalid outcome token asset');
  return asset;
})();

/** Кошелёк-аккаунт; каждый вызов — новый объект с той же идентичностью. */
export function walletAccount(address = '0x1234567890abcdef1234567890abcdef12345678'): AccountId {
  const wallet = parseWalletAddress(address);
  if (wallet === undefined) throw new Error('fixture failed: invalid wallet address');
  return accountIdFromWallet(wallet);
}

/** Комиссия в заданном активе; по умолчанию — USDC. */
export function fee(value: number, asset: AssetId = AssetIdHelpers.USDC): Fee {
  return must(FeeService.create(asset, value));
}

/** Цена исхода. */
export function price(value: number): OutcomePrice {
  return must(OutcomePriceService.create(value));
}

/** Количество. */
export function qty(value: number): Quantity {
  return must(QuantityService.create(value));
}

/** Параметры исполнения, которые тест переопределяет точечно. */
export interface FillOverrides {
  readonly id?: string;
  readonly orderId?: string;
  readonly accountId?: AccountId;
  readonly venueId?: VenueId;
  readonly marketId?: MarketId;
  readonly tokenId?: AssetId;
  readonly settlementAssetId?: AssetId;
  readonly price?: number;
  readonly size?: number;
  readonly side?: Side;
  readonly timestampMs?: number;
  readonly fee?: number;
  /** Актив комиссии — отдельно от величины */
  readonly feeAsset?: AssetId;
}

/**
 * Исполнение — canonical факт сделки.
 *
 * @param overrides - Что отличается от «нормального» исполнения
 * @returns Валидный `Fill`
 */
export function fill(overrides: FillOverrides = {}): Fill {
  return must(
    Fill.create({
      id: asFillId(overrides.id ?? 'fill-1') as FillId,
      orderId: asOrderId(overrides.orderId ?? 'order-1') as OrderId,
      accountId: overrides.accountId ?? walletAccount(),
      venueId: overrides.venueId ?? VENUE,
      marketId: overrides.marketId ?? MARKET,
      tokenId: overrides.tokenId ?? UP_TOKEN,
      settlementAssetId: overrides.settlementAssetId ?? AssetIdHelpers.USDC,
      price: price(overrides.price ?? 0.65),
      size: qty(overrides.size ?? 40),
      side: overrides.side ?? 'BUY',
      timestamp: ts(overrides.timestampMs ?? 1_700_000_100_000),
      fee: fee(overrides.fee ?? 0, overrides.feeAsset ?? AssetIdHelpers.USDC),
    }),
  );
}

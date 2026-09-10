/**
 * Фикстуры для тестов сравнения заявок.
 *
 * @remarks
 * Состояние заявки строится ДОМЕНОМ (`Order.create`, `accept`, `cancel`,
 * `applyFill`), а не собирается руками: `status`, `filledSize`,
 * `averagePrice` и `fillIds` связаны инвариантами агрегата, и фикстура,
 * обходящая их, проверяла бы не тот объект.
 */
import {
  accountIdFromWallet,
  asFillId,
  asOrderId,
  asPolymarketCtfToken,
  parseWalletAddress,
  type AccountId,
  type AssetId,
  type FillId,
  type OrderId,
  type StrategyId,
} from '@polymarket/ids';
import { TimestampService, type Timestamp } from '@polymarket/timestamp';
import {
  OutcomePriceService,
  QuantityService,
  type OutcomePrice,
  type Quantity,
  type Side,
} from '@polymarket/value-objects';
import { Order } from '../src/Order.js';

/** Разворачивает `Result` фикстуры: отказ здесь — дефект самого теста. */
export function must<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!result.ok) throw new Error(`fixture failed: ${String(result.error)}`);
  return result.value as T;
}

/** Момент времени из миллисекунд. */
export function ts(ms: number): Timestamp {
  return must(TimestampService.create(ms));
}

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

/** Кошелёк-аккаунт; каждый вызов — новый объект с той же идентичностью. */
export function walletAccount(address = '0x1234567890abcdef1234567890abcdef12345678'): AccountId {
  const wallet = parseWalletAddress(address);
  if (wallet === undefined) throw new Error('fixture failed: invalid wallet address');
  return accountIdFromWallet(wallet);
}

/** Цена исхода. */
export function price(value: number): OutcomePrice {
  return must(OutcomePriceService.create(value));
}

/** Количество. */
export function qty(value: number): Quantity {
  return must(QuantityService.create(value));
}

/** Параметры заявки, которые тест переопределяет точечно. */
export interface OrderOverrides {
  readonly id?: string;
  /** `null` означает «владельца НЕТ»; `undefined` — оставить по умолчанию */
  readonly accountId?: AccountId | null;
  readonly asset?: AssetId;
  readonly side?: Side;
  readonly price?: number;
  readonly size?: number;
  readonly timestampMs?: number;
  readonly strategyId?: StrategyId;
}

/**
 * Заявка в статусе `PENDING` — то, что создаёт `Order.create`.
 *
 * @param overrides - Что отличается от «нормальной» заявки
 * @returns Валидный `Order`
 */
export function order(overrides: OrderOverrides = {}): Order {
  const owner = overrides.accountId === null ? undefined : overrides.accountId ?? walletAccount();
  return must(
    Order.create({
      id: asOrderId(overrides.id ?? 'order-1') as OrderId,
      asset: overrides.asset ?? UP_TOKEN,
      side: overrides.side ?? 'BUY',
      price: price(overrides.price ?? 0.65),
      size: qty(overrides.size ?? 100),
      timestamp: ts(overrides.timestampMs ?? 1_700_000_000_000),
      ...(owner === undefined ? {} : { accountId: owner }),
      ...(overrides.strategyId === undefined ? {} : { strategyId: overrides.strategyId }),
    }),
  );
}

/**
 * Применяет исполнение к заявке доменным путём.
 *
 * @param source - Заявка, к которой применяется исполнение
 * @param params - Идентификатор исполнения, объём и цена
 * @returns Заявка после исполнения
 */
export function withFill(
  source: Order,
  params: { id?: string; size?: number; price?: number } = {},
): Order {
  return must(
    source.applyFill({
      id: asFillId(params.id ?? 'fill-1') as FillId,
      orderId: source.id,
      asset: source.asset,
      side: source.side,
      size: qty(params.size ?? 40),
      price: params.price === undefined ? source.price : price(params.price),
    }),
  );
}

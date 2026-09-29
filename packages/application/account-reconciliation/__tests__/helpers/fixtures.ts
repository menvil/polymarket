/**
 * Фикстуры domain-сущностей для тестов сверки.
 *
 * @remarks
 * Всё собирается НАСТОЯЩИМИ domain-конструкторами: `Portfolio.create`,
 * `Order.create`, `Fill.create`. Проектор проверяет снимок canonical-
 * равенствами (`samePortfolioState`, `sameOrderState`, `findFillFactDifference`),
 * и структурная заглушка проверяла бы не тот код, который поедет в прод.
 *
 * Своя копия, а не импорт фикстур `@polymarket/account-state`: тестовые
 * помощники чужого пакета — не его публичный контракт.
 */
import { TokenBalance } from '@polymarket/value-objects/token-balance';
import { TimestampService, type Timestamp } from '@polymarket/timestamp';
import {
  Balance,
  FeeService,
  MoneyService,
  OutcomePriceService,
  QuantityService,
  type Side,
} from '@polymarket/value-objects';
import {
  AssetIdHelpers,
  accountIdFromWallet,
  asFillId,
  asMarketId,
  asOrderId,
  asPolymarketCtfToken,
  asPositionId,
  asVenueId,
  parseWalletAddress,
  type AccountId,
  type AssetId,
  type FillId,
  type InstrumentId,
  type OrderId,
  type VenueId,
} from '@polymarket/ids';
import { Fill } from '@polymarket/fill';
import { Order } from '@polymarket/order';
import { Portfolio, asPortfolioId } from '@polymarket/portfolio';
import { Position, PositionLot } from '@polymarket/position';

/** Разворачивает `Result` фикстуры: отказ здесь — дефект самого теста. */
export function must<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!result.ok) throw new Error(`fixture failed: ${String(result.error)}`);
  return result.value as T;
}

/** Момент времени из миллисекунд. */
export function ts(ms: number): Timestamp {
  return must(TimestampService.create(ms));
}

/** Площадка тестовых аккаунтов. */
export const VENUE: VenueId = asVenueId('POLYMARKET') as VenueId;

/**
 * Кошелёк-аккаунт.
 *
 * @param address - Hex-адрес
 * @returns WALLET-аккаунт; каждый вызов — новый объект той же идентичности
 */
export function walletAccount(address = '0x1234567890abcdef1234567890abcdef12345678'): AccountId {
  const wallet = parseWalletAddress(address);
  if (wallet === undefined) throw new Error('fixture failed: invalid wallet address');
  return accountIdFromWallet(wallet);
}

/** Второй аккаунт — для проверки независимости аккаунтов. */
export const SECOND_WALLET = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

/** CTF-токен исхода UP. */
export const UP_TOKEN: AssetId = (() => {
  const asset = asPolymarketCtfToken('100000000000000000000000000000000000000000000001');
  if (asset === undefined) throw new Error('fixture failed: invalid CTF token');
  return asset;
})();

/** Инструмент токена UP. */
export const UP_INSTRUMENT = '100000000000000000000000000000000000000000000001' as InstrumentId;

/** Параметры портфеля, которые тест меняет точечно. */
export interface PortfolioOverrides {
  readonly accountId?: AccountId;
  readonly available?: number;
  readonly reserved?: number;
  /** Количество позиции по UP; без него позиции нет */
  readonly upQuantity?: number;
}

/**
 * Валидный портфель.
 *
 * @param overrides - Что отличается от умолчания
 * @returns `Portfolio` с согласованными позицией и токенным балансом
 *
 * @remarks
 * Позиция — настоящая лотовая `Position` с одним лотом: именно такой портфель
 * обязан отдавать будущий authoritative-адаптер (см. README пакета).
 */
export function portfolio(overrides: PortfolioOverrides = {}): Portfolio {
  const accountId = overrides.accountId ?? walletAccount();
  const positions = new Map<InstrumentId, Position>();
  const tokenBalances = new Map<InstrumentId, TokenBalance>();
  if (overrides.upQuantity !== undefined) {
    const quantity = must(QuantityService.create(overrides.upQuantity));
    const openedAt = ts(1_700_000_000_000);
    positions.set(
      UP_INSTRUMENT,
      must(
        Position.create({
          id: asPositionId('position-up') as never,
          accountId,
          instrumentId: UP_INSTRUMENT,
          asset: UP_TOKEN,
          side: 'LONG',
          openedAt,
          lots: [
            PositionLot.create({
              quantity,
              entryPrice: must(OutcomePriceService.create(0.65)),
              timestamp: openedAt,
            }),
          ],
        }),
      ),
    );
    tokenBalances.set(
      UP_INSTRUMENT,
      TokenBalance.of(UP_INSTRUMENT, quantity, must(QuantityService.create(0)), accountId, VENUE),
    );
  }

  return must(
    Portfolio.create({
      id: asPortfolioId('portfolio-1'),
      accountId,
      balance: Balance.of(
        must(MoneyService.create(overrides.available ?? 10_000, 'USDC')),
        must(MoneyService.create(overrides.reserved ?? 0, 'USDC')),
        accountId,
        VENUE,
      ),
      positions,
      tokenBalances,
    }),
  );
}

/**
 * Заявка в статусе `OPEN`.
 *
 * @param id - Идентификатор заявки
 * @param accountId - Владелец
 * @returns Принятая площадкой заявка
 */
export function openOrder(id: string, accountId: AccountId = walletAccount()): Order {
  const created = must(
    Order.create({
      id: asOrderId(id) as OrderId,
      asset: UP_TOKEN,
      side: 'BUY',
      price: must(OutcomePriceService.create(0.65)),
      size: must(QuantityService.create(100)),
      timestamp: ts(1_700_000_000_000),
      accountId,
    }),
  );
  return must(created.accept());
}

/**
 * Заявка в статусе `PENDING` — отправлена, площадка ещё не подтвердила.
 *
 * @param id - Идентификатор заявки
 * @param accountId - Владелец
 * @returns Заявка сразу после `Order.create`
 */
export function pendingOrder(id: string, accountId: AccountId = walletAccount()): Order {
  return must(
    Order.create({
      id: asOrderId(id) as OrderId,
      asset: UP_TOKEN,
      side: 'BUY',
      price: must(OutcomePriceService.create(0.65)),
      size: must(QuantityService.create(100)),
      timestamp: ts(1_700_000_000_000),
      accountId,
    }),
  );
}

/**
 * Применяет исполнение к заявке доменным путём.
 *
 * @param source - Заявка
 * @param fillId - Идентификатор исполнения
 * @param size - Объём исполнения
 * @returns Заявка после исполнения
 */
export function withFill(source: Order, fillId: string, size: number): Order {
  return must(
    source.applyFill({
      id: asFillId(fillId) as FillId,
      orderId: source.id,
      asset: source.asset,
      side: source.side,
      size: must(QuantityService.create(size)),
      price: source.price,
    }),
  );
}

/**
 * Исполнение заявки.
 *
 * @param params - Идентификатор, заявка, владелец, объём и сторона
 * @returns Canonical `Fill`
 */
export function fill(params: {
  id: string;
  orderId: string;
  accountId?: AccountId;
  size?: number;
  side?: Side;
}): Fill {
  return must(
    Fill.create({
      id: asFillId(params.id) as FillId,
      orderId: asOrderId(params.orderId) as OrderId,
      accountId: params.accountId ?? walletAccount(),
      venueId: VENUE,
      marketId: asMarketId('market-btc-updown') as never,
      tokenId: UP_TOKEN,
      settlementAssetId: AssetIdHelpers.USDC,
      price: must(OutcomePriceService.create(0.65)),
      size: must(QuantityService.create(params.size ?? 40)),
      side: params.side ?? 'BUY',
      timestamp: ts(1_700_000_100_000),
      fee: must(FeeService.create(AssetIdHelpers.USDC, 0)),
    }),
  );
}

/**
 * Логгер-заглушка для `EventBus`.
 *
 * @remarks
 * Отвергнутые события в этих тестах ожидаемы и проверяются по `Err`, а не по
 * строкам в консоли.
 */
export const silentLogger = (() => {
  const logger: Record<string, unknown> = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
  };
  logger['child'] = () => logger;
  return logger as never;
})();

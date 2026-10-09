/**
 * Чистые преобразования ответов официального SDK Polymarket в canonical-типы
 * authoritative-состояния аккаунта.
 *
 * @remarks
 * Здесь нет ни сети, ни часов, ни состояния — только перевод формата площадки
 * в canonical value objects с отказом (`Err`) на всё, что нельзя перевести
 * ОДНОЗНАЧНО. Правило одно для всех функций модуля:
 *
 * ```text
 * непонятное, противоречивое, пустое, нечисловое → Err
 * «разумное значение по умолчанию»                → никогда
 * ```
 *
 * ### Числа — без `number`
 *
 * Количества, цены и балансы приходят строками и переводятся в
 * `Quantity`/`OutcomePrice`/`Money` через service-фасады value objects —
 * без `parseFloat`/`Number(...)`. Перед этим строка проверяется строгим
 * шаблоном: экспоненты, знаки, пробелы и `NaN` отвергаются здесь, а не
 * «прощаются» парсером.
 *
 * ### Сделки — одно canonical-правило с приватным WS
 *
 * REST `ClobTrade` переводится в ту же snake_case-форму, что и WS-событие, и
 * разбирается ТЕМ ЖЕ `FillMapper.allFromPolymarketTradeEvent`. Отдельной
 * политики `FillId`, владения maker-заявкой и cross-outcome здесь нет — только
 * переименование полей и явный перевод статуса.
 */
import type { AuthoritativeFillState, AuthoritativeOpenOrderState, AuthoritativeOrderState, AuthoritativeOutcomeAssetId } from '@polymarket/account-reconciliation';
import type { TradeStatus as VendorTradeStatus } from '@polymarket/bindings';
import type { ClobTrade, OpenOrder } from '@polymarket/bindings/clob';
import {
  FillMapper,
  findFillFactDifference,
  type ExecutionMetadata,
  type PolymarketTradeEventMappingOptions,
  type TradeStatus,
} from '@polymarket/fill';
import {
  asMarketId,
  asOrderId,
  asPolymarketCtfToken,
  assetIdToString,
  isPolymarketCtfToken,
  type AccountId,
} from '@polymarket/ids';
import { Err, Ok, type Result } from '@polymarket/result';
import { TimestampService } from '@polymarket/timestamp';
import {
  MoneyService,
  OutcomePriceService,
  QuantityService,
  type Money,
  type Quantity,
  type Side,
} from '@polymarket/value-objects';
import type { PolymarketTakerFeeRateResolver } from './PolymarketTakerFeeRateResolver.js';

/**
 * Отказ перевода или чтения состояния аккаунта Polymarket.
 *
 * @remarks
 * Инфраструктурная ошибка ВНУТРИ адаптера: что именно не удалось и почему.
 * Наружу из порта она выходит обёрнутой в `AccountReconciliationSourceError`
 * (как `originalError`) — сверка видит один тип отказа источника.
 *
 * @example
 * ```typescript
 * return Err(new PolymarketAccountStateError('open order 0xabc: unknown status "PAUSED"'));
 * ```
 */
export class PolymarketAccountStateError extends Error {
  public override readonly name = 'PolymarketAccountStateError';

  /**
   * @param message - Что не удалось (англ.)
   * @param options - Исходная причина, если есть
   */
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}

/**
 * Число знаков после запятой у балансов `balance-allowance`.
 *
 * @remarks
 * И collateral, и outcome-токены Polymarket считаются в базовых единицах с
 * шестью знаками (legacy `PolymarketBalanceRestClient` делил оба на 1e6).
 * Размеры заявок и сделок CLOB, напротив, уже нормализованы в shares.
 */
export const POLYMARKET_BALANCE_DECIMALS = 6;

/**
 * Предел длины баланса в базовых единицах.
 *
 * @remarks
 * `Money` ограничен 1e15; в базовых единицах это 22 цифры. Строка длиннее —
 * не «очень большой баланс», а дефект ответа: отказ, а не усечение.
 */
const MAX_BASE_UNIT_DIGITS = 22;

/** Неотрицательное целое без знака, пробелов и экспоненты. */
const BASE_UNITS_PATTERN = /^\d+$/;

/** Неотрицательная десятичная дробь без знака, пробелов и экспоненты. */
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Базовые единицы баланса → десятичная строка.
 *
 * @param raw - Значение `balance` из ответа SDK
 * @param field - Имя поля для текста ошибки
 * @returns Точная десятичная строка (`"1234567"` → `"1.234567"`) либо отказ
 *
 * @remarks
 * Деление на 1e6 сделано сдвигом запятой в строке — точно и без `number`.
 * `undefined`, `NaN`, отрицательное, дробное и слишком длинное значение —
 * отказ. Ноль допустим: это настоящий нулевой баланс.
 *
 * @example
 * ```typescript
 * baseUnitsToDecimalString('5', 'balance');       // Ok('0.000005')
 * baseUnitsToDecimalString('-1', 'balance');      // Err
 * ```
 */
export function baseUnitsToDecimalString(
  raw: unknown,
  field: string,
): Result<string, PolymarketAccountStateError> {
  if (typeof raw !== 'string' || !BASE_UNITS_PATTERN.test(raw)) {
    return Err(new PolymarketAccountStateError(`${field}: expected non-negative integer base units, got ${describe(raw)}`));
  }
  const digits = raw.replace(/^0+(?=\d)/, '');
  if (digits.length > MAX_BASE_UNIT_DIGITS) {
    return Err(new PolymarketAccountStateError(`${field}: base units out of range (${digits.length} digits)`));
  }
  const padded = digits.padStart(POLYMARKET_BALANCE_DECIMALS + 1, '0');
  return Ok(`${padded.slice(0, -POLYMARKET_BALANCE_DECIMALS)}.${padded.slice(-POLYMARKET_BALANCE_DECIMALS)}`);
}

/**
 * Collateral-баланс в базовых единицах → canonical `Money`.
 *
 * @param raw - Значение `balance`
 * @returns Деньги в canonical расчётной валюте `USDC` либо отказ
 *
 * @remarks
 * Collateral выражается в `USDC`, потому что это единственная валюта, которую
 * сегодня поддерживает canonical `Money`/`Portfolio`, и в ней же
 * `Fill.settlementAssetId`. Это НЕ утверждение, что физический collateral-токен
 * площадки — USDC.
 *
 * TODO(open architectural decision): current canonical Portfolio supports only
 * USDC; current Polymarket CLOB V2 collateral is pUSD. Before the state matcher
 * is allowed to mutate Portfolio, the canonical collateral representation must
 * explicitly decide whether pUSD is represented as its own currency or
 * intentionally normalized to a USD-equivalent accounting unit.
 *
 * @example
 * ```typescript
 * collateralFromBaseUnits('1000000'); // Ok(Money 1 USDC)
 * ```
 */
export function collateralFromBaseUnits(raw: unknown): Result<Money, PolymarketAccountStateError> {
  const decimal = baseUnitsToDecimalString(raw, 'collateral balance');
  if (!decimal.ok) return decimal;
  const money = MoneyService.create(decimal.value, 'USDC');
  if (!money.ok) {
    return Err(new PolymarketAccountStateError(`collateral balance: ${money.error.message}`, { cause: money.error }));
  }
  return Ok(money.value);
}

/**
 * Баланс outcome-токена в базовых единицах → canonical `Quantity`.
 *
 * @param raw - Значение `balance`
 * @returns Количество токенов либо отказ
 *
 * @example
 * ```typescript
 * outcomeQuantityFromBaseUnits('2500000'); // Ok(Quantity 2.5)
 * ```
 */
export function outcomeQuantityFromBaseUnits(raw: unknown): Result<Quantity, PolymarketAccountStateError> {
  const decimal = baseUnitsToDecimalString(raw, 'outcome token balance');
  if (!decimal.ok) return decimal;
  return quantityFrom(decimal.value, 'outcome token balance');
}

/**
 * Статус сделки SDK → canonical `TradeStatus`.
 *
 * @param raw - `ClobTrade.status` (значения enum `TradeStatus` из `@polymarket/bindings`)
 * @returns Canonical статус либо отказ
 *
 * @remarks
 * Перевод — явная таблица, без подстрок и регистров.
 * `TRADE_STATUS_MATCHED_NOT_BROADCASTED` в canonical `TradeStatus` не входит
 * и до отдельного решения — отказ, а не «примерно MATCHED». Пустой или
 * незнакомый статус — тоже отказ: сделку нельзя ни выбросить, ни угадать.
 *
 * @example
 * ```typescript
 * mapPolymarketTradeStatus('TRADE_STATUS_MINED'); // Ok('MINED')
 * ```
 */
export function mapPolymarketTradeStatus(raw: unknown): Result<TradeStatus, PolymarketAccountStateError> {
  if (!isVendorTradeStatus(raw)) {
    return Err(new PolymarketAccountStateError(`unknown trade status ${describe(raw)}`));
  }
  const status = TRADE_STATUS_POLICY[raw];
  if (status === 'REFUSED') {
    return Err(
      new PolymarketAccountStateError(`trade status ${raw} has no canonical TradeStatus yet; refusing to guess`),
    );
  }
  return Ok(status);
}

/**
 * Политика по КАЖДОМУ значению enum `TradeStatus` SDK.
 *
 * @remarks
 * `Record` по всем значениям enum (через template literal type): новый статус
 * в SDK не пройдёт молча — таблица перестанет компилироваться и потребует
 * решения. Значения записаны строками, потому что от SDK здесь берётся только
 * тип: runtime-код SDK в пакете не загружается.
 */
const TRADE_STATUS_POLICY: Readonly<Record<`${VendorTradeStatus}`, TradeStatus | 'REFUSED'>> = {
  TRADE_STATUS_MATCHED: 'MATCHED',
  TRADE_STATUS_MINED: 'MINED',
  TRADE_STATUS_CONFIRMED: 'CONFIRMED',
  TRADE_STATUS_RETRYING: 'RETRYING',
  TRADE_STATUS_FAILED: 'FAILED',
  TRADE_STATUS_MATCHED_NOT_BROADCASTED: 'REFUSED',
};

/**
 * Является ли значение известным статусом сделки SDK.
 *
 * @param raw - Значение из ответа
 * @returns `true`, если это ключ {@link TRADE_STATUS_POLICY}
 */
function isVendorTradeStatus(raw: unknown): raw is `${VendorTradeStatus}` {
  return typeof raw === 'string' && Object.hasOwn(TRADE_STATUS_POLICY, raw);
}

/**
 * Статус заявки CLOB → canonical статус с учётом исполненного объёма.
 *
 * @param order - Заявка из `listOpenOrders`/`fetchOrder`
 * @returns Состояние заявки в любом authoritative статусе либо отказ
 *
 * @remarks
 * Документированные статусы заявки CLOB: `LIVE`, `MATCHED`, `CANCELED`,
 * `CANCELED_MARKET_RESOLVED`, `INVALID`. Перевод — только там, где он
 * однозначен вместе с `sizeMatched`:
 *
 * ```text
 * LIVE                      sizeMatched = 0              → OPEN
 * LIVE                      0 < sizeMatched < size       → PARTIALLY_FILLED
 * MATCHED                   sizeMatched = size           → FILLED
 * CANCELED                  sizeMatched < size           → CANCELED
 * CANCELED_MARKET_RESOLVED  sizeMatched < size           → CANCELED (остаток снят при резолюции)
 * INVALID                                                → Err (смысл не определён)
 * всё остальное и любое противоречие с sizeMatched       → Err
 * ```
 *
 * `REJECTED` и `EXPIRED` площадка этим путём не сообщает — их здесь нет, а
 * не «угадываются». `strategyId` и прочие локальные поля не нужны: ручная
 * заявка того же аккаунта переводится так же.
 *
 * @example
 * ```typescript
 * const state = mapPolymarketOrderState(await client.fetchOrder({ orderId }));
 * ```
 */
export function mapPolymarketOrderState(order: OpenOrder): Result<AuthoritativeOrderState, PolymarketAccountStateError> {
  const facts = parseOrderFacts(order);
  if (!facts.ok) return facts;
  const { size, filledSize } = facts.value;
  const label = `order ${order.id}`;
  const nothingFilled = filledSize.isZero();
  const fullyFilled = filledSize.equals(size);

  switch (order.status) {
    case 'LIVE':
      if (fullyFilled) {
        return Err(new PolymarketAccountStateError(`${label}: LIVE but size_matched equals original_size`));
      }
      return Ok({ ...facts.value, status: nothingFilled ? 'OPEN' : 'PARTIALLY_FILLED' });
    case 'MATCHED':
      if (!fullyFilled) {
        return Err(new PolymarketAccountStateError(`${label}: MATCHED but size_matched is below original_size`));
      }
      return Ok({ ...facts.value, status: 'FILLED' });
    case 'CANCELED':
    case 'CANCELED_MARKET_RESOLVED':
      if (fullyFilled) {
        return Err(new PolymarketAccountStateError(`${label}: ${order.status} but fully matched`));
      }
      return Ok({ ...facts.value, status: 'CANCELED' });
    case 'INVALID':
      return Err(new PolymarketAccountStateError(`${label}: status INVALID has no canonical mapping yet`));
    default:
      return Err(new PolymarketAccountStateError(`${label}: unknown order status ${describe(order.status)}`));
  }
}

/**
 * Живая заявка из `listOpenOrders` → `AuthoritativeOpenOrderState`.
 *
 * @param order - Заявка из списка открытых
 * @returns Живая заявка (`OPEN`/`PARTIALLY_FILLED`) либо отказ
 *
 * @remarks
 * Список открытых обязан содержать только `LIVE`. Терминальный или
 * незнакомый статус здесь — противоречие источника, а не повод отфильтровать
 * запись.
 *
 * @example
 * ```typescript
 * for await (const page of client.listOpenOrders()) page.items.map(mapPolymarketOpenOrder);
 * ```
 */
export function mapPolymarketOpenOrder(
  order: OpenOrder,
): Result<AuthoritativeOpenOrderState, PolymarketAccountStateError> {
  if (order.status !== 'LIVE') {
    return Err(
      new PolymarketAccountStateError(`open order ${order.id}: listOpenOrders returned non-live status ${describe(order.status)}`),
    );
  }
  const state = mapPolymarketOrderState(order);
  if (!state.ok) return state;
  const { status } = state.value;
  if (status !== 'OPEN' && status !== 'PARTIALLY_FILLED') {
    return Err(new PolymarketAccountStateError(`open order ${order.id}: derived non-live status ${status}`));
  }
  return Ok({ ...state.value, status });
}

/** Неизменяемые факты заявки без статуса. */
type OrderFacts = Omit<AuthoritativeOrderState, 'status'>;

/**
 * Проверяет и переводит поля заявки, общие для всех статусов.
 *
 * @param order - Заявка SDK
 * @returns Факты заявки либо отказ
 */
function parseOrderFacts(order: OpenOrder): Result<OrderFacts, PolymarketAccountStateError> {
  const label = `order ${describe(order.id)}`;
  const orderId = typeof order.id === 'string' ? asOrderId(order.id) : undefined;
  if (orderId === undefined) return Err(new PolymarketAccountStateError(`${label}: invalid order id`));

  const asset = outcomeAssetFrom(order.tokenId);
  if (!asset.ok) return Err(new PolymarketAccountStateError(`${label}: ${asset.error.message}`));

  const side = sideFrom(order.side);
  if (!side.ok) return Err(new PolymarketAccountStateError(`${label}: ${side.error.message}`));

  const price = decimalFrom(order.price, 'price');
  if (!price.ok) return Err(new PolymarketAccountStateError(`${label}: ${price.error.message}`));
  const outcomePrice = OutcomePriceService.create(price.value);
  if (!outcomePrice.ok) {
    return Err(new PolymarketAccountStateError(`${label}: price ${price.value} is not a valid outcome price`, { cause: outcomePrice.error }));
  }

  const size = quantityFromDecimal(order.originalSize, 'original_size');
  if (!size.ok) return Err(new PolymarketAccountStateError(`${label}: ${size.error.message}`));
  if (size.value.isZero()) return Err(new PolymarketAccountStateError(`${label}: original_size is zero`));

  const filledSize = quantityFromDecimal(order.sizeMatched, 'size_matched');
  if (!filledSize.ok) return Err(new PolymarketAccountStateError(`${label}: ${filledSize.error.message}`));
  if (filledSize.value.isGreaterThan(size.value)) {
    return Err(new PolymarketAccountStateError(`${label}: size_matched exceeds original_size`));
  }

  return Ok({
    orderId,
    asset: asset.value,
    side: side.value,
    price: outcomePrice.value,
    size: size.value,
    filledSize: filledSize.value,
  });
}

/**
 * Контекст разбора сделок одного аккаунта.
 *
 * @remarks
 * `makerAddress` — НАШ адрес из конфигурации адаптера, а не из ответа: по нему
 * `FillMapper` находит наши maker-заявки в сделке. `takerFeeRates` — источник
 * ставки комиссии тейкера: REST `feeRateBps` для этого непригоден.
 */
export interface PolymarketTradeContext {
  /** Аккаунт, которому принадлежат исполнения */
  readonly accountId: AccountId;
  /** Наш адрес maker-заявок, в нижнем регистре */
  readonly makerAddress: string;
  /** Ставка taker-комиссии по рынку сделки */
  readonly takerFeeRates: PolymarketTakerFeeRateResolver;
}

/**
 * REST `ClobTrade` → snake_case-форма, которую понимает `FillMapper`.
 *
 * @param trade - Сделка аккаунта из `listAccountTrades`
 * @param context - Наш адрес maker-заявок
 * @returns Объект в форме WS user-channel события либо отказ
 *
 * @remarks
 * Только переименование и явный перевод статуса — никакой своей политики:
 *
 * ```text
 * id → id                    takerOrderId → taker_order_id
 * traderSide → trader_side   conditionId → market
 * tokenId → asset_id         side, price, size → как есть (строки)
 * transactionHash → transaction_hash
 * feeRateBps → НЕ передаётся (в REST приходит "0"; ставку даёт резолвер)
 * status → canonical (без префикса TRADE_STATUS_)
 * matchedAt (ISO) → timestamp (мс): время исполнения, а не время сообщения
 * makerOrders[] → maker_orders[] (order_id, matched_amount, price, asset_id,
 *                                 side, owner, maker_address, outcome)
 * maker_address → НАШ адрес из конфигурации
 * owner         → НЕ передаётся
 * ```
 *
 * `owner` верхнего уровня намеренно не передаётся: `FillMapper` признаёт
 * maker-заявку нашей и по совпадению `owner`, а в cross-outcome сделке
 * верхний уровень описывает тейкера. Владение здесь определяется только
 * адресом аккаунта — тем же для любой его заявки, включая ручные.
 *
 * `feeRateBps` (и верхнего уровня, и maker-заявок) намеренно не передаётся:
 * в REST он приходит `"0"`, и `FillMapper` выбрал бы по нему нулевую
 * комиссию тейкера. Ставку `mapPolymarketClobTrade` берёт у резолвера.
 *
 * @example
 * ```typescript
 * const raw = polymarketClobTradeToFillMapperInput(trade, { makerAddress: '0xabc…' });
 * if (raw.ok) FillMapper.allFromPolymarketTradeEvent(raw.value, accountId);
 * ```
 */
export function polymarketClobTradeToFillMapperInput(
  trade: ClobTrade,
  context: { readonly makerAddress: string },
): Result<Record<string, unknown>, PolymarketAccountStateError> {
  const label = `trade ${describe(trade.id)}`;
  const status = mapPolymarketTradeStatus(trade.status);
  if (!status.ok) return Err(new PolymarketAccountStateError(`${label}: ${status.error.message}`));

  if (trade.traderSide !== 'TAKER' && trade.traderSide !== 'MAKER') {
    return Err(new PolymarketAccountStateError(`${label}: unknown trader side ${describe(trade.traderSide)}`));
  }
  const matchedAt = typeof trade.matchedAt === 'string' ? TimestampService.fromISO(trade.matchedAt) : undefined;
  if (matchedAt === undefined || !matchedAt.ok) {
    return Err(new PolymarketAccountStateError(`${label}: invalid matched time ${describe(trade.matchedAt)}`));
  }
  if (!Array.isArray(trade.makerOrders)) {
    return Err(new PolymarketAccountStateError(`${label}: maker orders are missing`));
  }

  return Ok({
    id: trade.id,
    taker_order_id: trade.takerOrderId,
    trader_side: trade.traderSide,
    market: trade.conditionId,
    asset_id: trade.tokenId,
    side: trade.side,
    price: trade.price,
    size: trade.size,
    status: status.value,
    maker_address: context.makerAddress,
    maker_orders: trade.makerOrders.map((makerOrder) => ({
      order_id: makerOrder.orderId,
      matched_amount: makerOrder.matchedAmount,
      price: makerOrder.price,
      asset_id: makerOrder.tokenId,
      side: makerOrder.side,
      owner: makerOrder.owner,
      maker_address: makerOrder.makerAddress,
      outcome: makerOrder.outcome,
    })),
    timestamp: String(matchedAt.value.toNumber()),
    transaction_hash: trade.transactionHash,
  });
}

/**
 * Сделка аккаунта → authoritative-исполнения через canonical `FillMapper`.
 *
 * @param trade - Сделка из `listAccountTrades`
 * @param context - Аккаунт, наш адрес maker-заявок и источник ставки комиссии
 * @returns Исполнения сделки (у multi-maker — несколько) либо отказ
 *
 * @remarks
 * 1. Статус → canonical (неизвестный — отказ, сделка не выбрасывается).
 * 2. TAKER-сделка, в которой наш адрес есть и среди maker-заявок, — self-match:
 *    правило `FillId` такой случай не представляет → отказ, а не половина
 *    сделки.
 * 3. TAKER-сделка: ставка комиссии — у `context.takerFeeRates` по рынку
 *    сделки (`conditionId`). Отказ резолвера — отказ сделки. `feeRateBps` из
 *    ответа на комиссию не влияет. MAKER-сделка ставку не запрашивает:
 *    мейкер комиссию не платит.
 * 4. REST-форма → `FillMapper.allFromPolymarketTradeEvent` с этой ставкой —
 *    ТО ЖЕ правило `FillId`, владения и cross-outcome, что у приватного WS.
 *    MAKER-сделка без нашей maker-заявки — отказ `FillMapper`, а не откат на
 *    чужой верхний уровень.
 * 5. Статус каждого исполнения обязан совпасть с canonical статусом сделки.
 *
 * @example
 * ```typescript
 * const fills = mapPolymarketClobTrade(trade, { accountId, makerAddress, takerFeeRates });
 * ```
 */
export function mapPolymarketClobTrade(
  trade: ClobTrade,
  context: PolymarketTradeContext,
): Result<readonly AuthoritativeFillState[], PolymarketAccountStateError> {
  const label = `trade ${describe(trade.id)}`;
  const raw = polymarketClobTradeToFillMapperInput(trade, context);
  if (!raw.ok) return raw;

  if (
    trade.traderSide === 'TAKER' &&
    trade.makerOrders.some((makerOrder) => sameAddress(makerOrder.makerAddress, context.makerAddress))
  ) {
    return Err(
      new PolymarketAccountStateError(`${label}: our address is both taker and maker (self-match is not representable)`),
    );
  }

  const options = takerFeeOptions(trade, context);
  if (!options.ok) return options;

  const mapped = FillMapper.allFromPolymarketTradeEvent(raw.value, context.accountId, options.value);
  if (!mapped.ok) {
    return Err(new PolymarketAccountStateError(`${label}: ${mapped.error.message}`, { cause: mapped.error }));
  }

  const expectedStatus = raw.value['status'];
  const fills: AuthoritativeFillState[] = [];
  for (const { fill, metadata } of mapped.value) {
    if (metadata.tradeStatus === undefined || metadata.tradeStatus !== expectedStatus) {
      return Err(new PolymarketAccountStateError(`${label}: fill ${fill.id} lost its venue trade status`));
    }
    fills.push({ fill, metadata: { ...metadata, tradeStatus: metadata.tradeStatus } });
  }
  return Ok(fills);
}

/**
 * Ставка taker-комиссии для `FillMapper`: только у TAKER-сделки и только от
 * резолвера.
 *
 * @param trade - Сделка с уже проверенной стороной
 * @param context - Источник ставки
 * @returns Опции `FillMapper` либо отказ резолвера
 */
function takerFeeOptions(
  trade: ClobTrade,
  context: PolymarketTradeContext,
): Result<PolymarketTradeEventMappingOptions, PolymarketAccountStateError> {
  if (trade.traderSide !== 'TAKER') return Ok({});
  const label = `trade ${describe(trade.id)}`;
  const marketId = typeof trade.conditionId === 'string' ? asMarketId(trade.conditionId) : undefined;
  if (marketId === undefined) {
    return Err(new PolymarketAccountStateError(`${label}: invalid market ${describe(trade.conditionId)}`));
  }
  const rate = context.takerFeeRates.getTakerFeeRate(marketId);
  if (!rate.ok) {
    return Err(new PolymarketAccountStateError(`${label}: ${rate.error.message}`, { cause: rate.error }));
  }
  return Ok({ takerFeeRate: rate.value });
}

/**
 * Сливает исполнения, полученные несколькими запросами или страницами.
 *
 * @param fills - Исполнения в порядке получения
 * @returns Исполнения без повторов либо отказ
 *
 * @remarks
 * ```text
 * тот же FillId + тот же факт + те же метаданные   → повтор, одна запись
 * тот же FillId + другой факт или метаданные       → Err
 * ```
 *
 * Факт сравнивается canonical `findFillFactDifference`. Два разных статуса
 * одной сделки в ОДНОМ проходе — противоречие ответа: какой из них новее,
 * отсюда не видно, и выбирать первый или последний нельзя.
 *
 * @example
 * ```typescript
 * const merged = mergeAuthoritativeFills([...marketA, ...marketB]);
 * ```
 */
export function mergeAuthoritativeFills(
  fills: readonly AuthoritativeFillState[],
): Result<readonly AuthoritativeFillState[], PolymarketAccountStateError> {
  const byId = new Map<string, AuthoritativeFillState>();
  for (const candidate of fills) {
    const key = String(candidate.fill.id);
    const existing = byId.get(key);
    if (existing === undefined) {
      byId.set(key, candidate);
      continue;
    }
    const difference = findFillFactDifference(existing.fill, candidate.fill);
    if (difference !== undefined) {
      return Err(
        new PolymarketAccountStateError(`fill ${key}: duplicate with a different fact (${difference.field})`),
      );
    }
    if (!sameMetadata(existing.metadata, candidate.metadata)) {
      return Err(new PolymarketAccountStateError(`fill ${key}: duplicate with different venue metadata`));
    }
  }
  return Ok([...byId.values()]);
}

/** Равенство метаданных исполнения по всем полям `ExecutionMetadata`. */
function sameMetadata(left: ExecutionMetadata, right: ExecutionMetadata): boolean {
  return (
    left.tradeStatus === right.tradeStatus &&
    left.liquidity === right.liquidity &&
    left.venueTradeId === right.venueTradeId
  );
}

/**
 * Сравнение EVM-адресов без учёта регистра.
 *
 * @param left - Адрес
 * @param right - Адрес
 * @returns `true`, если адреса совпадают
 */
function sameAddress(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

/**
 * Числовой идентификатор токена → outcome-актив.
 *
 * @param tokenId - `tokenId` из ответа SDK
 * @returns `POLYMARKET_CTF_TOKEN` либо отказ
 */
function outcomeAssetFrom(tokenId: unknown): Result<AuthoritativeOutcomeAssetId, PolymarketAccountStateError> {
  const asset = typeof tokenId === 'string' ? asPolymarketCtfToken(tokenId) : undefined;
  if (asset === undefined || !isPolymarketCtfToken(asset)) {
    return Err(new PolymarketAccountStateError(`invalid token id ${describe(tokenId)}`));
  }
  return Ok(asset);
}

/**
 * Сторона заявки — строго `BUY` или `SELL`.
 *
 * @param raw - `side` из ответа SDK
 * @returns Сторона либо отказ
 */
function sideFrom(raw: unknown): Result<Side, PolymarketAccountStateError> {
  if (raw === 'BUY' || raw === 'SELL') return Ok(raw);
  return Err(new PolymarketAccountStateError(`unknown side ${describe(raw)}`));
}

/**
 * Проверяет строгую десятичную запись.
 *
 * @param raw - Значение из ответа SDK
 * @param field - Имя поля для текста ошибки
 * @returns Та же строка либо отказ
 */
function decimalFrom(raw: unknown, field: string): Result<string, PolymarketAccountStateError> {
  if (typeof raw !== 'string' || !DECIMAL_PATTERN.test(raw)) {
    return Err(new PolymarketAccountStateError(`${field}: expected a non-negative decimal string, got ${describe(raw)}`));
  }
  return Ok(raw);
}

/**
 * Десятичная строка shares → `Quantity`.
 *
 * @param raw - Значение из ответа SDK
 * @param field - Имя поля для текста ошибки
 * @returns Количество либо отказ
 */
function quantityFromDecimal(raw: unknown, field: string): Result<Quantity, PolymarketAccountStateError> {
  const decimal = decimalFrom(raw, field);
  if (!decimal.ok) return decimal;
  return quantityFrom(decimal.value, field);
}

/**
 * Проверенная десятичная строка → `Quantity`.
 *
 * @param decimal - Десятичная строка
 * @param field - Имя поля для текста ошибки
 * @returns Количество либо отказ value object
 */
function quantityFrom(decimal: string, field: string): Result<Quantity, PolymarketAccountStateError> {
  const quantity = QuantityService.create(decimal);
  if (!quantity.ok) {
    return Err(new PolymarketAccountStateError(`${field}: ${quantity.error.message}`, { cause: quantity.error }));
  }
  return Ok(quantity.value);
}

/**
 * Читаемое представление произвольного значения для текста ошибки.
 *
 * @param value - Что угодно из ответа
 * @returns Короткая строка
 */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return value === undefined ? 'undefined' : String(value);
}

/**
 * Canonical-строка актива для ключей и текста ошибок.
 *
 * @param asset - Outcome-актив
 * @returns `assetIdToString(asset)`
 */
export function outcomeAssetKey(asset: AuthoritativeOutcomeAssetId): string {
  return assetIdToString(asset);
}

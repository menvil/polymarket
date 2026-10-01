/**
 * Контракт authoritative-наблюдений площадки: что в нём ЕСТЬ и чего в нём
 * быть НЕ может.
 *
 * @remarks
 * Главные проверки — на этапе компиляции: `tsc --noEmit` включает
 * `__tests__`, а ts-jest компилирует файл перед запуском. Если из контракта
 * исчезнет запрет (`PENDING` станет допустимым, `tradeStatus` —
 * необязательным, у позиции появятся лоты, у заявки — `strategyId`), то
 * неиспользованный `@ts-expect-error` или неверное `Equal<…>` сломают
 * компиляцию, а не runtime-ассерт.
 *
 * Отсутствие поля проверяется через `keyof`, а не рефлексией: интерфейс —
 * контракт для адаптера, и вопрос «может ли адаптер передать `strategyId`»
 * решает компилятор, а не содержимое конкретного объекта.
 *
 * Все импорты — из корня пакета: заодно фиксируется публичный экспорт.
 */
import { describe, expect, it } from '@jest/globals';
import type { ExecutionMetadata, Fill, TradeStatus } from '@polymarket/fill';
import { Ok, type Result } from '@polymarket/result';
import { asOrderId, type AccountId, type AssetId, type OrderId, type VenueId } from '@polymarket/ids';
import {
  MoneyService,
  OutcomePriceService,
  QuantityService,
  type Quantity,
} from '@polymarket/value-objects';
import {
  AccountReconciliationSourceError,
  type AccountVenueObservationSourceOperation,
  type AuthoritativeAccountObservation,
  type AuthoritativeExecutionMetadata,
  type AuthoritativeFillObservation,
  type AuthoritativeOrderObservation,
  type AuthoritativeOrderStatus,
  type AuthoritativePositionObservation,
  type IAccountVenueObservationSource,
} from '../src/index.js';
import { UP_TOKEN, VENUE, fill, must, portfolio, walletAccount } from './helpers/fixtures.js';

/**
 * Точное равенство типов.
 *
 * @remarks
 * Взаимная присваиваемость (`A extends B` и `B extends A`) здесь не годится:
 * она не отличает `readonly`/необязательность и схлопывает `any`. Сравнение
 * через отложенные условные типы требует ИДЕНТИЧНОСТИ.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const ORDER_ID = asOrderId('order-1') as OrderId;

/** Наблюдение заявки с заданным статусом. */
function orderObservation(status: AuthoritativeOrderStatus): AuthoritativeOrderObservation {
  return {
    orderId: ORDER_ID,
    asset: UP_TOKEN,
    side: 'BUY',
    price: must(OutcomePriceService.create(0.42)),
    size: must(QuantityService.create(10)),
    filledSize: must(QuantityService.create(status === 'PARTIALLY_FILLED' ? 4 : 0)),
    status,
  };
}

/**
 * Минимальная реализация порта.
 *
 * @remarks
 * Её существование — тоже проверка: порт реализуем одними canonical-типами,
 * без `Portfolio`, `Position` и canonical `Order`.
 */
class InMemoryVenueObservationSource implements IAccountVenueObservationSource {
  constructor(
    private readonly _observation: AuthoritativeAccountObservation,
    private readonly _assetBalance: Quantity,
  ) {}

  async getAccountObservation(
    _venueId: VenueId,
    _accountId: AccountId,
  ): Promise<Result<AuthoritativeAccountObservation, AccountReconciliationSourceError>> {
    return Ok(this._observation);
  }

  async getOrderObservation(
    _venueId: VenueId,
    _accountId: AccountId,
    orderId: OrderId,
  ): Promise<Result<AuthoritativeOrderObservation | undefined, AccountReconciliationSourceError>> {
    return Ok(this._observation.openOrders.find((order) => order.orderId === orderId));
  }

  async getAssetBalance(
    _venueId: VenueId,
    _accountId: AccountId,
    _asset: AssetId,
  ): Promise<Result<Quantity, AccountReconciliationSourceError>> {
    return Ok(this._assetBalance);
  }
}

describe('AuthoritativeAccountObservation: факты площадки, а не Portfolio', () => {
  it('состоит ровно из collateral, владений, живых заявок и сделок — без available/reserved', () => {
    const keys: Equal<
      keyof AuthoritativeAccountObservation,
      'collateralBalance' | 'positions' | 'openOrders' | 'fills'
    > = true;
    void keys;

    const accountId = walletAccount();
    const observation: AuthoritativeAccountObservation = {
      collateralBalance: must(MoneyService.create(100, 'USDC')),
      positions: [],
      openOrders: [],
      fills: [],
      // @ts-expect-error — резервация локальна: площадка её не сообщает
      availableCollateral: must(MoneyService.create(100, 'USDC')),
    };
    void observation;

    // @ts-expect-error — локальный Portfolio не является наблюдением площадки
    const fromPortfolio: AuthoritativeAccountObservation = portfolio({ accountId });
    void fromPortfolio;
    expect(true).toBe(true);
  });

  it('порт реализуем одними canonical-типами и отдаёт наблюдение как есть', async () => {
    const accountId = walletAccount();
    const venueFill = fill({ id: 'fill-1', orderId: 'order-1', accountId, size: 4 });
    const observation: AuthoritativeAccountObservation = {
      collateralBalance: must(MoneyService.create(95.8, 'USDC')),
      positions: [{ asset: UP_TOKEN, quantity: must(QuantityService.create(4)) }],
      openOrders: [orderObservation('PARTIALLY_FILLED')],
      fills: [{ fill: venueFill, metadata: { tradeStatus: 'MATCHED', liquidity: 'MAKER' } }],
    };
    const source: IAccountVenueObservationSource = new InMemoryVenueObservationSource(
      observation,
      must(QuantityService.create(4)),
    );

    const observed = await source.getAccountObservation(VENUE, accountId);
    expect(observed).toEqual(Ok(observation));

    const order = await source.getOrderObservation(VENUE, accountId, ORDER_ID);
    expect(order.ok && order.value?.status).toBe('PARTIALLY_FILLED');
    const unknown = await source.getOrderObservation(VENUE, accountId, asOrderId('order-404') as OrderId);
    expect(unknown).toEqual(Ok(undefined));

    const held = await source.getAssetBalance(VENUE, accountId, UP_TOKEN);
    expect(held.ok && held.value.value().toString()).toBe('4');
  });
});

describe('AuthoritativeOrderObservation: только то, что знает площадка', () => {
  it('поля — ровно venue-known; strategyId, timestamp, reason, fillIds, accountId нет', () => {
    const keys: Equal<
      keyof AuthoritativeOrderObservation,
      'orderId' | 'asset' | 'side' | 'price' | 'size' | 'filledSize' | 'status'
    > = true;
    void keys;

    const withStrategy: AuthoritativeOrderObservation = {
      ...orderObservation('OPEN'),
      // @ts-expect-error — автор заявки — локальное знание; площадка его не сообщает
      strategyId: 'strategy-123',
    };
    void withStrategy;
    expect(true).toBe(true);
  });

  it('PENDING не может быть authoritative-статусом', () => {
    // @ts-expect-error — PENDING — локальное состояние рантайма, площадка его не подтверждает
    const pending: AuthoritativeOrderStatus = 'PENDING';
    void pending;

    // @ts-expect-error — и внутри наблюдения тоже
    const pendingObservation: AuthoritativeOrderObservation = { ...orderObservation('OPEN'), status: 'PENDING' };
    void pendingObservation;
    expect(true).toBe(true);
  });

  it('состав статусов закреплён: новый OrderStatus не станет authoritative молча', () => {
    // Сломается, если в OrderStatus появится статус: решить, локальный он
    // (добавить в Exclude) или подтверждаемый площадкой (добавить сюда).
    const exact: Equal<
      AuthoritativeOrderStatus,
      'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED'
    > = true;
    void exact;

    const statuses: readonly AuthoritativeOrderStatus[] = [
      'OPEN',
      'PARTIALLY_FILLED',
      'FILLED',
      'CANCELED',
      'REJECTED',
      'EXPIRED',
    ];
    expect(statuses.map((status) => orderObservation(status).status)).toEqual(statuses);
  });
});

describe('AuthoritativeFillObservation: статус сделки на площадке обязателен', () => {
  it('без tradeStatus наблюдение не компилируется', () => {
    const venueFill = fill({ id: 'fill-1', orderId: 'order-1' });

    // @ts-expect-error — tradeStatus обязателен: сделка в ответе площадки ≠ финальная
    const withoutStatus: AuthoritativeFillObservation = { fill: venueFill, metadata: { liquidity: 'TAKER' } };
    void withoutStatus;

    // @ts-expect-error — metadata обязательна целиком
    const withoutMetadata: AuthoritativeFillObservation = { fill: venueFill };
    void withoutMetadata;

    // @ts-expect-error — голый Fill не является authoritative-наблюдением
    const bareFill: AuthoritativeFillObservation = venueFill;
    void bareFill;

    // @ts-expect-error — Fill[] без venue status нельзя отдать как сделки наблюдения
    const bareFills: AuthoritativeAccountObservation['fills'] = [venueFill];
    void bareFills;
    expect(true).toBe(true);
  });

  it('canonical ExecutionMetadata (tradeStatus необязателен) не сужается в authoritative молча', () => {
    const live: ExecutionMetadata = { liquidity: 'MAKER' };
    // @ts-expect-error — у живого потока tradeStatus может не быть; authoritative его требует
    const authoritative: AuthoritativeExecutionMetadata = live;
    void authoritative;

    // Обратное направление разрешено: authoritative-метаданные — частный случай canonical.
    const widened: ExecutionMetadata = { tradeStatus: 'CONFIRMED' } satisfies AuthoritativeExecutionMetadata;
    expect(widened.tradeStatus).toBe('CONFIRMED');
  });

  it('принимается любой статус площадки — включая нефинальные и FAILED', () => {
    const venueFill: Fill = fill({ id: 'fill-1', orderId: 'order-1' });
    const statuses: readonly TradeStatus[] = ['MATCHED', 'MINED', 'RETRYING', 'CONFIRMED', 'FAILED'];
    const observations: AuthoritativeFillObservation[] = statuses.map((tradeStatus) => ({
      fill: venueFill,
      metadata: { tradeStatus },
    }));
    expect(observations.map((observation) => observation.metadata.tradeStatus)).toEqual(statuses);
  });
});

describe('AuthoritativePositionObservation: владение без лотов', () => {
  it('поля — asset, quantity и диагностика; lots нет', () => {
    const keys: Equal<
      keyof AuthoritativePositionObservation,
      'asset' | 'quantity' | 'averagePrice' | 'entryCost'
    > = true;
    void keys;

    const withLots: AuthoritativePositionObservation = {
      asset: UP_TOKEN,
      quantity: must(QuantityService.create(10)),
      // @ts-expect-error — площадка лотов не знает; лоты — локальная provenance
      lots: [],
    };
    void withLots;
    expect(true).toBe(true);
  });

  it('диагностические averagePrice и entryCost необязательны', () => {
    const minimal: AuthoritativePositionObservation = {
      asset: UP_TOKEN,
      quantity: must(QuantityService.create(10)),
    };
    const withDiagnostics: AuthoritativePositionObservation = {
      ...minimal,
      averagePrice: must(OutcomePriceService.create(0.41)),
      entryCost: must(MoneyService.create(4.1, 'USDC')),
    };
    expect(minimal.averagePrice).toBeUndefined();
    expect(withDiagnostics.averagePrice?.value().toString()).toBe('0.41');
  });
});

describe('ошибки порта наблюдений', () => {
  it('операции — ровно методы порта', () => {
    const exact: Equal<AccountVenueObservationSourceOperation, keyof IAccountVenueObservationSource> = true;
    void exact;
    expect(true).toBe(true);
  });

  it.each<AccountVenueObservationSourceOperation>([
    'getAccountObservation',
    'getOrderObservation',
    'getAssetBalance',
  ])('%s → тот же AccountReconciliationSourceError с SOURCE_FAILED', (operation) => {
    const accountId = walletAccount();
    const error = new AccountReconciliationSourceError(operation, VENUE, accountId, 'HTTP 503');

    expect(error.failureCode).toBe('SOURCE_FAILED');
    expect(error.operation).toBe(operation);
    expect(error.message).toContain(operation);
  });
});

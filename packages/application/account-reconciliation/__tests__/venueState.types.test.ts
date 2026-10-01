/**
 * Контракт authoritative текущего состояния площадки: что в нём ЕСТЬ и чего в
 * нём быть НЕ может.
 *
 * @remarks
 * Главные проверки — на этапе компиляции: `tsc --noEmit` включает
 * `__tests__`, а ts-jest компилирует файл перед запуском. Если из контракта
 * исчезнет запрет (`PENDING` станет допустимым, `tradeStatus` —
 * необязательным, у позиции появятся лоты, у заявки — `strategyId`, у
 * исполнения — origin), то неиспользованный `@ts-expect-error` или неверное
 * `Equal<…>` сломают компиляцию, а не runtime-ассерт.
 *
 * Отсутствие поля проверяется через `keyof`, а не рефлексией: интерфейс —
 * контракт для адаптера, и вопрос «может ли адаптер передать `strategyId`»
 * решает компилятор, а не содержимое конкретного объекта.
 *
 * Все импорты — из корня пакета: заодно фиксируется публичный экспорт.
 */
import { describe, expect, it } from '@jest/globals';
import type { ExecutionMetadata, TradeStatus } from '@polymarket/fill';
import { Ok, type Result } from '@polymarket/result';
import { asOrderId, type AccountId, type AssetId, type OrderId, type VenueId } from '@polymarket/ids';
import {
  MoneyService,
  OutcomePriceService,
  QuantityService,
  type Quantity,
  type Side,
} from '@polymarket/value-objects';
import {
  AccountReconciliationSourceError,
  type AccountVenueStateSourceOperation,
  type AuthoritativeAccountState,
  type AuthoritativeFillMetadata,
  type AuthoritativeFillState,
  type AuthoritativeOrderState,
  type AuthoritativeOrderStatus,
  type AuthoritativePositionState,
  type IAccountVenueStateSource,
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

/** Состояние заявки площадки с заданными статусом и стороной. */
function venueOrder(status: AuthoritativeOrderStatus, side: Side = 'BUY'): AuthoritativeOrderState {
  return {
    orderId: ORDER_ID,
    asset: UP_TOKEN,
    side,
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
 * без `Portfolio`, `Position`, canonical `Order` и без какого-либо знания о
 * локальном состоянии.
 */
class InMemoryVenueStateSource implements IAccountVenueStateSource {
  constructor(
    private readonly _state: AuthoritativeAccountState,
    private readonly _assetBalance: Quantity,
  ) {}

  async getAccountState(
    _venueId: VenueId,
    _accountId: AccountId,
  ): Promise<Result<AuthoritativeAccountState, AccountReconciliationSourceError>> {
    return Ok(this._state);
  }

  async getOrderState(
    _venueId: VenueId,
    _accountId: AccountId,
    orderId: OrderId,
  ): Promise<Result<AuthoritativeOrderState | undefined, AccountReconciliationSourceError>> {
    return Ok(this._state.openOrders.find((order) => order.orderId === orderId));
  }

  async getAssetBalance(
    _venueId: VenueId,
    _accountId: AccountId,
    _asset: AssetId,
  ): Promise<Result<Quantity, AccountReconciliationSourceError>> {
    return Ok(this._assetBalance);
  }
}

describe('AuthoritativeAccountState: факты площадки, а не Portfolio', () => {
  it('состоит ровно из collateral, владений, живых заявок и сделок — без available/reserved', () => {
    const keys: Equal<
      keyof AuthoritativeAccountState,
      'collateralBalance' | 'positions' | 'openOrders' | 'fills'
    > = true;
    void keys;

    const accountId = walletAccount();
    const state: AuthoritativeAccountState = {
      collateralBalance: must(MoneyService.create(1_000, 'USDC')),
      positions: [],
      openOrders: [],
      fills: [],
      // @ts-expect-error — резервация — наша форма представления; площадка её не сообщает
      availableCollateral: must(MoneyService.create(750, 'USDC')),
    };
    void state;

    // @ts-expect-error — локальный Portfolio не является состоянием площадки
    const fromPortfolio: AuthoritativeAccountState = portfolio({ accountId });
    void fromPortfolio;
    expect(true).toBe(true);
  });

  it('порт реализуем одними canonical-типами и отдаёт состояние как есть', async () => {
    const accountId = walletAccount();
    const state: AuthoritativeAccountState = {
      collateralBalance: must(MoneyService.create(1_000, 'USDC')),
      positions: [{ asset: UP_TOKEN, quantity: must(QuantityService.create(4)) }],
      openOrders: [venueOrder('PARTIALLY_FILLED')],
      fills: [
        {
          fill: fill({ id: 'fill-1', orderId: 'order-1', accountId, size: 4 }),
          metadata: { tradeStatus: 'MATCHED', liquidity: 'MAKER' },
        },
      ],
    };
    const source: IAccountVenueStateSource = new InMemoryVenueStateSource(
      state,
      must(QuantityService.create(4)),
    );

    expect(await source.getAccountState(VENUE, accountId)).toEqual(Ok(state));

    const order = await source.getOrderState(VENUE, accountId, ORDER_ID);
    expect(order.ok && order.value?.status).toBe('PARTIALLY_FILLED');
    // undefined — «источник не может доказать», а не терминальный статус
    const unknown = await source.getOrderState(VENUE, accountId, asOrderId('order-404') as OrderId);
    expect(unknown).toEqual(Ok(undefined));

    const held = await source.getAssetBalance(VENUE, accountId, UP_TOKEN);
    expect(held.ok && held.value.value().toString()).toBe('4');
  });
});

describe('AuthoritativeOrderState: только факты, которыми владеет площадка', () => {
  it('поля — ровно venue-owned; локальные strategyId/decisionId/intentId/timestamp/reason/fillIds не нужны', () => {
    const keys: Equal<
      keyof AuthoritativeOrderState,
      'orderId' | 'asset' | 'side' | 'price' | 'size' | 'filledSize' | 'status'
    > = true;
    void keys;

    // Валидно без каких-либо локальных полей.
    const minimal: AuthoritativeOrderState = venueOrder('OPEN');
    expect(minimal.status).toBe('OPEN');

    const withStrategy: AuthoritativeOrderState = {
      ...minimal,
      // @ts-expect-error — автор заявки — локальное знание; площадка его не сообщает
      strategyId: 'strategy-123',
    };
    void withStrategy;
  });

  it('PENDING не может быть authoritative-статусом', () => {
    // @ts-expect-error — PENDING — локальный жизненный цикл до приёма площадкой
    const pending: AuthoritativeOrderStatus = 'PENDING';
    void pending;

    // @ts-expect-error — и внутри состояния заявки тоже
    const pendingOrder: AuthoritativeOrderState = { ...venueOrder('OPEN'), status: 'PENDING' };
    void pendingOrder;
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
    expect(statuses.map((status) => venueOrder(status).status)).toEqual(statuses);
  });
});

describe('AuthoritativeFillState: статус сделки на площадке обязателен', () => {
  it('без tradeStatus состояние не компилируется', () => {
    const venueFill = fill({ id: 'fill-1', orderId: 'order-1' });

    // @ts-expect-error — tradeStatus обязателен: сделка в ответе площадки ≠ финальная
    const withoutStatus: AuthoritativeFillState = { fill: venueFill, metadata: { liquidity: 'TAKER' } };
    void withoutStatus;

    // @ts-expect-error — metadata обязательна целиком
    const withoutMetadata: AuthoritativeFillState = { fill: venueFill };
    void withoutMetadata;

    // @ts-expect-error — голый Fill не является authoritative-состоянием исполнения
    const bareFill: AuthoritativeFillState = venueFill;
    void bareFill;

    // @ts-expect-error — Fill[] без venue status нельзя отдать как сделки состояния
    const bareFills: AuthoritativeAccountState['fills'] = [venueFill];
    void bareFills;
    expect(true).toBe(true);
  });

  it('canonical ExecutionMetadata (tradeStatus необязателен) не сужается в authoritative молча', () => {
    const live: ExecutionMetadata = { liquidity: 'MAKER' };
    // @ts-expect-error — у живого потока tradeStatus может не быть; authoritative его требует
    const authoritative: AuthoritativeFillMetadata = live;
    void authoritative;

    // Обратное направление разрешено: authoritative-метаданные — частный случай canonical.
    const widened: ExecutionMetadata = { tradeStatus: 'CONFIRMED' } satisfies AuthoritativeFillMetadata;
    expect(widened.tradeStatus).toBe('CONFIRMED');
  });

  it('метаданные не добавляют своих полей к canonical ExecutionMetadata', () => {
    const sameKeys: Equal<keyof AuthoritativeFillMetadata, keyof ExecutionMetadata> = true;
    void sameKeys;
    expect(true).toBe(true);
  });

  it('принимается любой статус площадки без потери — включая нефинальные и FAILED', () => {
    const venueFill = fill({ id: 'fill-1', orderId: 'order-1' });
    const statuses: readonly TradeStatus[] = ['MATCHED', 'MINED', 'RETRYING', 'CONFIRMED', 'FAILED'];
    const venueFills: AuthoritativeFillState[] = statuses.map((tradeStatus) => ({
      fill: venueFill,
      metadata: { tradeStatus },
    }));
    expect(venueFills.map((venue) => venue.metadata.tradeStatus)).toEqual(statuses);
  });
});

describe('AuthoritativePositionState: текущий инвентарь без лотов', () => {
  it('поля — asset, quantity и справка; lots нет', () => {
    const keys: Equal<
      keyof AuthoritativePositionState,
      'asset' | 'quantity' | 'averagePrice' | 'entryCost'
    > = true;
    void keys;

    const withLots: AuthoritativePositionState = {
      asset: UP_TOKEN,
      quantity: must(QuantityService.create(10)),
      // @ts-expect-error — площадка лотов не знает; лоты — локальная provenance
      lots: [],
    };
    void withLots;
    expect(true).toBe(true);
  });

  it('справочные averagePrice и entryCost необязательны', () => {
    const minimal: AuthoritativePositionState = {
      asset: UP_TOKEN,
      quantity: must(QuantityService.create(10)),
    };
    const withReference: AuthoritativePositionState = {
      ...minimal,
      averagePrice: must(OutcomePriceService.create(0.42)),
      entryCost: must(MoneyService.create(4.2, 'USDC')),
    };
    expect(minimal.averagePrice).toBeUndefined();
    expect(withReference.averagePrice?.value().toString()).toBe('0.42');
  });
});

describe('неизвестный инициатор допустим', () => {
  it('ни заявка, ни исполнение, ни их метаданные не несут оси происхождения или локального владения', () => {
    type StateKeys = keyof AuthoritativeOrderState | keyof AuthoritativeFillState | keyof AuthoritativeFillMetadata;
    const noOrigin: Equal<
      Extract<StateKeys, 'origin' | 'initiator' | 'strategyId' | 'decisionId' | 'intentId'>,
      never
    > = true;
    void noOrigin;
    expect(true).toBe(true);
  });

  it('заявка и исполнение, которых рантайм не создавал, — валидное состояние аккаунта', async () => {
    // Заявку создали вне рантайма (UI площадки, другой процесс): локально её
    // нет нигде, и ни одно поле не требует это доказать.
    const accountId = walletAccount();
    const externalOrderId = asOrderId('external-ui-order') as OrderId;
    const externalSell: AuthoritativeOrderState = {
      ...venueOrder('OPEN', 'SELL'),
      orderId: externalOrderId,
      size: must(QuantityService.create(5)),
    };
    const externalFill: AuthoritativeFillState = {
      fill: fill({ id: 'external-fill', orderId: 'external-ui-buy', accountId, size: 10 }),
      metadata: { tradeStatus: 'CONFIRMED' },
    };
    const source = new InMemoryVenueStateSource(
      {
        collateralBalance: must(MoneyService.create(1_000, 'USDC')),
        positions: [{ asset: UP_TOKEN, quantity: must(QuantityService.create(10)) }],
        openOrders: [externalSell],
        fills: [externalFill],
      },
      must(QuantityService.create(10)),
    );

    const state = await source.getAccountState(VENUE, accountId);
    expect(state.ok && state.value.openOrders.map((order) => order.orderId)).toEqual([externalOrderId]);
    expect(state.ok && state.value.fills[0].fill.orderId).toBe('external-ui-buy');

    const order = await source.getOrderState(VENUE, accountId, externalOrderId);
    expect(order.ok && order.value?.side).toBe('SELL');
  });
});

describe('ошибки порта состояния площадки', () => {
  it('операции — ровно методы порта', () => {
    const exact: Equal<AccountVenueStateSourceOperation, keyof IAccountVenueStateSource> = true;
    void exact;
    expect(true).toBe(true);
  });

  it.each<AccountVenueStateSourceOperation>(['getAccountState', 'getOrderState', 'getAssetBalance'])(
    '%s → тот же AccountReconciliationSourceError с SOURCE_FAILED',
    (operation) => {
      const error = new AccountReconciliationSourceError(operation, VENUE, walletAccount(), 'HTTP 503');

      expect(error.failureCode).toBe('SOURCE_FAILED');
      expect(error.operation).toBe(operation);
      expect(error.message).toContain(operation);
    },
  );
});

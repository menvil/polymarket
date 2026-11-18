/**
 * Семантика балансов CLOB и открытых заявок в `PolymarketAccountVenueStateSource`.
 *
 * @remarks
 * Тесты разделены по тому, КТО отвечает за вывод:
 *
 * 1. **Источник проверяет** — то, что верно в любой момент и не зависит от
 *    порядка запросов: формат и валюта баланса, ноль явно, полнота scope,
 *    привязка заявки и TAKER-сделки к кошельку, внутренняя согласованность
 *    заявки, полнота пагинации. Нарушение — `Err` всего прохода.
 * 2. **Выводит только matcher** — резервации и `available` из полного баланса
 *    и открытых заявок. Источник лишь сохраняет нужные факты точно;
 *    тестовая функция `deriveReservations` показывает, что их достаточно, и
 *    НЕ является реализацией matcher-а.
 * 3. **Требует свежего прохода** — расхождения, возможные из-за того, что
 *    запросы не атомарны (сделка между чтением баланса и заявок, заявка,
 *    исчезнувшая между чтениями). Источник отдаёт факты как есть и не чинит
 *    их угадыванием.
 *
 * Балансы в 1–2 читаются НАСТОЯЩИМ `PolymarketClobRefreshedBalanceReader`
 * поверх fake-порта `updateBalanceAllowance` — так проверяется вся цепочка от
 * ответа SDK до `AuthoritativeAccountState`. Утверждений о поведении
 * площадки, которые не подтверждены документацией, здесь нет.
 */
import { describe, expect, it } from '@jest/globals';
import {
  AccountReconciliationSourceError,
  type AuthoritativeAccountState,
  type AuthoritativeOpenOrderState,
} from '@polymarket/account-reconciliation';
import type { BalanceAllowanceResponse } from '@polymarket/bindings/clob';
import { assetIdToString, parseAssetId } from '@polymarket/ids';
import {
  PolymarketAccountVenueStateSource,
  PolymarketClobRefreshedBalanceReader,
  type PolymarketBalanceAllowanceRefresher,
  type PolymarketBalanceAllowanceRequest,
} from '@polymarket/polymarket-v2/account';
import {
  ACCOUNT,
  FakeAccountClient,
  FakeBalanceReader,
  FakePages,
  FakeTakerFeeRates,
  MARKET_A,
  MARKET_B,
  NO,
  NO_TOKEN_ID,
  OTHER_ADDRESS,
  OUR_ADDRESS,
  OUR_OWNER,
  TRADE_STATUS,
  VENUE,
  YES,
  YES_TOKEN_ID,
  buildSource,
  clobTrade,
  money,
  openOrder,
  orderId,
} from './helpers/accountFixtures.js';

/** Token id исхода вне scope (другой рынок). */
const OUTSIDE_TOKEN_ID = '300000000000000000000000000000000000000000000003';

/** Scope одного рынка с обоими исходами. */
const SCOPE = { marketIds: [MARKET_A], assets: [YES, NO] };

/**
 * Fake-порт `updateBalanceAllowance`: ответ по ключу запроса.
 *
 * @remarks
 * Ключ — `COLLATERAL` либо token id. Запрос без заданного ответа — ответ без
 * поля `balance` (как схема, отвергнутая бы SDK): reader обязан дать `Err`, а
 * не ноль.
 */
class KeyedRefresher implements PolymarketBalanceAllowanceRefresher {
  /** Запросы в порядке поступления */
  public readonly requests: PolymarketBalanceAllowanceRequest[] = [];

  /**
   * @param _responses - `balance` по ключу (`COLLATERAL` / token id); `Error` — отказ SDK
   */
  constructor(private readonly _responses: ReadonlyMap<string, unknown>) {}

  public updateBalanceAllowance(request: PolymarketBalanceAllowanceRequest): Promise<BalanceAllowanceResponse> {
    this.requests.push(request);
    const key = request.assetType === 'COLLATERAL' ? 'COLLATERAL' : request.tokenId;
    const balance = this._responses.get(key);
    if (balance instanceof Error) return Promise.reject(balance);
    const response = balance === undefined ? { allowances: {} } : { balance, allowances: {} };
    return Promise.resolve(response as unknown as BalanceAllowanceResponse);
  }
}

/**
 * Адаптер с настоящим CLOB-reader-ом поверх {@link KeyedRefresher}.
 *
 * @param responses - `balance` по ключу, в базовых единицах (6 знаков)
 * @returns Адаптер, fake-клиент и fake-порт обновления
 */
function sourceWithClobReader(responses: Record<string, unknown>): {
  source: PolymarketAccountVenueStateSource;
  client: FakeAccountClient;
  refresher: KeyedRefresher;
} {
  const refresher = new KeyedRefresher(new Map(Object.entries(responses)));
  const client = new FakeAccountClient();
  const created = PolymarketAccountVenueStateSource.create(
    { venueId: VENUE, accountId: ACCOUNT, makerAddress: OUR_ADDRESS },
    {
      client,
      balanceReader: new PolymarketClobRefreshedBalanceReader(refresher, OUR_ADDRESS),
      takerFeeRates: new FakeTakerFeeRates(),
    },
  );
  if (!created.ok) throw created.error;
  return { source: created.value, client, refresher };
}

/** Разворачивает успешный результат или роняет тест с причиной. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Ожидает отказ порта и возвращает его. */
function failure(result: { ok: boolean; error?: unknown }): AccountReconciliationSourceError {
  expect(result.ok).toBe(false);
  expect(result.error).toBeInstanceOf(AccountReconciliationSourceError);
  return result.error as AccountReconciliationSourceError;
}

/**
 * ТЕСТОВЫЙ вывод резерваций из фактов источника — иллюстрация того, что
 * фактов достаточно, а НЕ matcher.
 *
 * @param state - Состояние прохода
 * @returns Резервация collateral, доступный collateral и резервация токенов по активам scope
 *
 * @remarks
 * BUY резервирует `(size − filledSize) × price` collateral (комиссии нет:
 * стоящая заявка исполняется как maker). SELL резервирует `size − filledSize`
 * токенов, и только по активам, чей баланс есть в состоянии.
 */
function deriveReservations(state: AuthoritativeAccountState): {
  reservedCollateral: string;
  availableCollateral: string;
  reservedTokens: Record<string, string>;
} {
  const remaining = (order: AuthoritativeOpenOrderState) => order.size.value().minus(order.filledSize.value());
  const reservedCollateral = state.openOrders
    .filter((order) => order.side === 'BUY')
    .reduce((sum, order) => sum.plus(remaining(order).times(order.price.value())), state.collateralBalance.value().times(0));
  const scoped = new Set(state.assetBalances.map((balance) => assetIdToString(balance.asset)));
  const reservedTokens: Record<string, string> = {};
  for (const order of state.openOrders) {
    const key = assetIdToString(order.asset);
    if (order.side !== 'SELL' || !scoped.has(key)) continue;
    reservedTokens[key] = remaining(order).plus(reservedTokens[key] ?? 0).toString();
  }
  return {
    reservedCollateral: reservedCollateral.toString(),
    availableCollateral: state.collateralBalance.value().minus(reservedCollateral).toString(),
    reservedTokens,
  };
}

describe('1. источник проверяет: collateral', () => {
  it('balance COLLATERAL → полное владение в pUSD, точно из 6-знаковых базовых единиц', async () => {
    const { source, refresher } = sourceWithClobReader({ COLLATERAL: '100000000', [YES_TOKEN_ID]: '0', [NO_TOKEN_ID]: '0' });

    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));

    expect(state.collateralBalance.value().toString()).toBe('100');
    expect(state.collateralBalance.currency()).toBe('pUSD');
    expect(refresher.requests).toContainEqual({ assetType: 'COLLATERAL' });
  });

  it('нулевой collateral — явный Money(0, pUSD), а не отказ', async () => {
    const { source } = sourceWithClobReader({ COLLATERAL: '0', [YES_TOKEN_ID]: '0', [NO_TOKEN_ID]: '0' });
    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));
    expect(state.collateralBalance.isZero()).toBe(true);
    expect(state.collateralBalance.currency()).toBe('pUSD');
  });

  it.each<[string, unknown]>([
    ['дробные базовые единицы', '1.5'],
    ['отрицательный', '-1'],
    ['не число', 'abc'],
    ['поля balance нет', undefined],
  ])('невалидный collateral (%s) → Err всего прохода, не ноль', async (_label, balance) => {
    const responses: Record<string, unknown> = { [YES_TOKEN_ID]: '0', [NO_TOKEN_ID]: '0' };
    if (balance !== undefined) responses['COLLATERAL'] = balance;
    const { source } = sourceWithClobReader(responses);
    expect(failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE)).message).toContain('collateral');
  });

  it('отказ обновления collateral (SDK бросил) → Err всего прохода с причиной', async () => {
    const cause = new Error('HTTP 503');
    const { source } = sourceWithClobReader({ COLLATERAL: cause, [YES_TOKEN_ID]: '0', [NO_TOKEN_ID]: '0' });
    const error = failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE));
    expect(error.message).toContain('collateral: balance refresh failed');
  });

  it('collateral не в pUSD (подменённый reader вернул USDC) → Err, курса нет', async () => {
    const reader = new FakeBalanceReader();
    reader.collateral = { ok: true, value: money('100', 'USDC') };
    const { source } = buildSource(undefined, reader);
    expect(failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE)).message).toContain('must be pUSD');
  });
});

describe('1. источник проверяет: outcome-активы scope', () => {
  it('количество — полное владение токеном, точно; запрос несёт token id этого актива', async () => {
    const { source, refresher } = sourceWithClobReader({ COLLATERAL: '0', [YES_TOKEN_ID]: '20000000', [NO_TOKEN_ID]: '1' });

    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));

    expect(state.assetBalances.map((balance) => [assetIdToString(balance.asset), balance.quantity.value().toString()])).toEqual([
      [assetIdToString(YES), '20'],
      [assetIdToString(NO), '0.000001'],
    ]);
    expect(refresher.requests).toEqual(
      expect.arrayContaining([
        { assetType: 'CONDITIONAL', tokenId: YES_TOKEN_ID },
        { assetType: 'CONDITIONAL', tokenId: NO_TOKEN_ID },
      ]),
    );
  });

  it('явный ноль актива — запись с нулём, а не её отсутствие', async () => {
    const { source } = sourceWithClobReader({ COLLATERAL: '0', [YES_TOKEN_ID]: '0', [NO_TOKEN_ID]: '0' });
    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));
    expect(state.assetBalances).toHaveLength(2);
    expect(state.assetBalances.every((balance) => balance.quantity.isZero())).toBe(true);
  });

  it('ответ без balance для актива scope → Err, а не молчаливый ноль', async () => {
    const { source } = sourceWithClobReader({ COLLATERAL: '0', [YES_TOKEN_ID]: '0' });
    expect(failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE)).message).toContain(`token ${NO_TOKEN_ID}`);
  });

  it('невалидное количество (дробные базовые единицы) → Err всего прохода', async () => {
    const { source } = sourceWithClobReader({ COLLATERAL: '0', [YES_TOKEN_ID]: '2.5', [NO_TOKEN_ID]: '0' });
    failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE));
  });

  it('актив без CLOB token id (OUTCOME_TOKEN, не POLYMARKET_CTF_TOKEN) → Err, без запроса его баланса', async () => {
    const onChain = parseAssetId(`OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0x${'a'.repeat(64)}:UP`);
    if (onChain === undefined || onChain.type !== 'OUTCOME_TOKEN') throw new Error('fixture failed');
    const { source, refresher } = sourceWithClobReader({ COLLATERAL: '0', [YES_TOKEN_ID]: '0' });

    const error = failure(await source.getAccountState(VENUE, ACCOUNT, { marketIds: [MARKET_A], assets: [YES, onChain] }));

    expect(error.message).toContain('only POLYMARKET_CTF_TOKEN assets have a CLOB token id');
    expect(refresher.requests.filter((request) => request.assetType === 'CONDITIONAL')).toEqual([
      { assetType: 'CONDITIONAL', tokenId: YES_TOKEN_ID },
    ]);
  });
});

describe('1. источник проверяет: открытые заявки', () => {
  it('несколько BUY и SELL, частичные исполнения, заявки вне scope — все сохранены как есть', async () => {
    const { source, client } = buildSource();
    client.openOrders = new FakePages([
      [
        openOrder({ id: '0xbuy-a', side: 'BUY', price: '0.6', originalSize: '50', sizeMatched: '0' }),
        openOrder({ id: '0xbuy-b', side: 'BUY', price: '0.4', originalSize: '50', sizeMatched: '0' }),
        openOrder({ id: '0xsell-yes-1', side: 'SELL', tokenId: YES_TOKEN_ID, price: '0.7', originalSize: '10', sizeMatched: '4' }),
      ],
      [
        openOrder({ id: '0xsell-yes-2', side: 'SELL', tokenId: YES_TOKEN_ID, price: '0.75', originalSize: '5', sizeMatched: '0' }),
        openOrder({ id: '0xbuy-outside', side: 'BUY', tokenId: OUTSIDE_TOKEN_ID, conditionId: MARKET_B, price: '0.5', originalSize: '10' }),
        openOrder({ id: '0xsell-outside', side: 'SELL', tokenId: OUTSIDE_TOKEN_ID, conditionId: MARKET_B, price: '0.5', originalSize: '3' }),
      ],
    ]);

    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));

    expect(client.openOrderRequests).toEqual([undefined]); // без фильтра по рынку
    expect(
      state.openOrders.map((order) => [String(order.orderId), order.side, order.size.value().toString(), order.filledSize.value().toString(), order.status]),
    ).toEqual([
      ['0xbuy-a', 'BUY', '50', '0', 'OPEN'],
      ['0xbuy-b', 'BUY', '50', '0', 'OPEN'],
      ['0xsell-yes-1', 'SELL', '10', '4', 'PARTIALLY_FILLED'],
      ['0xsell-yes-2', 'SELL', '5', '0', 'OPEN'],
      ['0xbuy-outside', 'BUY', '10', '0', 'OPEN'],
      ['0xsell-outside', 'SELL', '3', '0', 'OPEN'],
    ]);
    // Баланс актива вне scope источник НЕ добавляет: scope остаётся точным.
    expect(state.assetBalances.map((balance) => assetIdToString(balance.asset))).toEqual([assetIdToString(YES), assetIdToString(NO)]);
  });

  it('цена и объёмы сохраняются точно, без округления до 6 знаков', async () => {
    const { source, client } = buildSource();
    client.openOrders = new FakePages([[openOrder({ id: '0xprecise', price: '0.123', originalSize: '10.1234567', sizeMatched: '0.0000001' })]]);

    const [order] = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE)).openOrders;

    expect(order?.price.value().toString()).toBe('0.123');
    expect(order?.size.value().toString()).toBe('10.1234567');
    expect(order?.filledSize.value().toString()).toBe('1e-7');
  });

  it('заявка другого funder-кошелька под тем же API-ключом → Err, а не чужая резервация', async () => {
    const { source, client } = buildSource();
    client.openOrders = new FakePages([[openOrder({ id: '0xours' }), openOrder({ id: '0xforeign', makerAddress: OTHER_ADDRESS })]]);

    const error = failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE));

    expect(error.message).toContain('0xforeign');
    expect(error.message).toContain('is not the account wallet');
  });

  it('getOrderState: заявка другого кошелька → Err, а не её статус', async () => {
    const { source, client } = buildSource();
    client.fetchOrderImpl = () => Promise.resolve(openOrder({ id: '0xforeign', makerAddress: OTHER_ADDRESS, status: 'CANCELED' }));
    const error = failure(await source.getOrderState(VENUE, ACCOUNT, orderId('0xforeign')));
    expect(error.message).toContain('is not the account wallet');
  });

  it('сбой страницы N пагинации → Err, без частичного списка', async () => {
    const { source, client } = buildSource();
    client.openOrders = new FakePages([[openOrder({ id: '0xa' })], [openOrder({ id: '0xb' })]], 1);
    expect(failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE)).message).toContain('open orders pagination failed');
  });

  it('пагинатор повторил страницу (курсор конца не распознан) → Err, а не двойная резервация', async () => {
    // SDK считает концом курсор "LTE=", OpenAPI — пустой курсор. Если они
    // разойдутся, первая страница придёт снова: повтор заявки ловится здесь.
    const { source, client } = buildSource();
    const page = [openOrder({ id: '0xa' }), openOrder({ id: '0xb' })];
    client.openOrders = new FakePages([page, page]);
    expect(failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE)).message).toContain('returned twice');
  });
});

describe('1. источник проверяет: сделки аккаунта привязаны к кошельку', () => {
  it('TAKER-сделка другого кошелька под тем же API-ключом → Err, даже когда у того кошелька нет открытых заявок', async () => {
    // Проверка открытых заявок такую сделку не ловит: заявка B уже исполнена
    // и в /data/orders её нет, а в /data/trades сделка B есть.
    const { source, client } = buildSource();
    client.openOrders = new FakePages([[]]);
    client.trades.set(
      MARKET_A,
      new FakePages([[clobTrade({ id: 'trade-ours' }), clobTrade({ id: 'trade-b', takerOrderId: '0xb-taker', makerAddress: OTHER_ADDRESS })]]),
    );

    const error = failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE));

    expect(error.message).toContain(`trades market ${MARKET_A}`);
    expect(error.message).toContain('trade "trade-b": taker order maker');
    expect(error.message).toContain('is not the account wallet');
  });

  it('наша TAKER-сделка (адрес в другом регистре) и наша MAKER-сделка (верхний уровень тейкерский) → recentFills', async () => {
    const { source, client } = buildSource();
    client.trades.set(
      MARKET_A,
      new FakePages([
        [
          clobTrade({ id: 'trade-taker', takerOrderId: '0xour-taker', makerAddress: OUR_ADDRESS.toUpperCase().replace('0X', '0x') }),
          clobTrade({
            id: 'trade-maker',
            traderSide: 'MAKER',
            makerAddress: OTHER_ADDRESS,
            takerOrderId: '0xother-taker',
            side: 'SELL',
            price: '0.43',
            size: '5',
            makerOrders: [
              { orderId: '0xour-maker', tokenId: YES_TOKEN_ID, side: 'BUY', price: '0.43', matchedAmount: '5', makerAddress: OUR_ADDRESS, owner: OUR_OWNER },
            ],
          }),
        ],
      ]),
    );

    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));

    expect(state.recentFills.map(({ fill, metadata }) => [String(fill.id), String(fill.orderId), metadata.liquidity])).toEqual([
      ['trade-taker', '0xour-taker', 'TAKER'],
      ['trade-maker', '0xour-maker', 'MAKER'],
    ]);
  });
});

describe('1. источник проверяет: ответ противоречит документированному инварианту', () => {
  it.each<[string, Parameters<typeof openOrder>[0]]>([
    ['LIVE, но исполнена целиком (size_matched = original_size)', { status: 'LIVE', sizeMatched: '10' }],
    ['исполнено больше исходного объёма', { sizeMatched: '10.000001' }],
    ['терминальная заявка в списке открытых', { status: 'MATCHED', sizeMatched: '10' }],
  ])('%s → Err всего прохода', async (_label, overrides) => {
    const { source, client } = buildSource();
    client.openOrders = new FakePages([[openOrder(overrides)]]);
    failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE));
  });
});

describe('2. выводит только matcher: факты источника достаточны для резерваций', () => {
  it('collateral 100, BUY A 30 + BUY B 20 → reserved 50, available 50 (не 100 + 50)', async () => {
    const { source, client } = sourceWithClobReader({ COLLATERAL: '100000000', [YES_TOKEN_ID]: '0', [NO_TOKEN_ID]: '0' });
    client.openOrders = new FakePages([
      [
        openOrder({ id: '0xbuy-a', side: 'BUY', price: '0.6', originalSize: '50' }),
        openOrder({ id: '0xbuy-b', side: 'BUY', price: '0.4', originalSize: '50' }),
      ],
    ]);

    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));
    const derived = deriveReservations(state);

    // Источник отдаёт ПОЛНЫЙ collateral и не вычитает резервацию сам.
    expect(state.collateralBalance.value().toString()).toBe('100');
    expect(derived.reservedCollateral).toBe('50');
    expect(derived.availableCollateral).toBe('50');
  });

  it('частичное исполнение уменьшает резервацию до остатка: BUY 50 @ 0.6, исполнено 20 → 18', async () => {
    const { source, client } = buildSource();
    client.openOrders = new FakePages([[openOrder({ id: '0xbuy', side: 'BUY', price: '0.6', originalSize: '50', sizeMatched: '20' })]]);
    expect(deriveReservations(unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE))).reservedCollateral).toBe('18');
  });

  it('SELL резервируют токены своего актива scope; SELL вне scope токенный учёт не трогает', async () => {
    const { source, client } = sourceWithClobReader({ COLLATERAL: '0', [YES_TOKEN_ID]: '20000000', [NO_TOKEN_ID]: '0' });
    client.openOrders = new FakePages([
      [
        openOrder({ id: '0xsell-1', side: 'SELL', tokenId: YES_TOKEN_ID, originalSize: '10', sizeMatched: '4' }),
        openOrder({ id: '0xsell-2', side: 'SELL', tokenId: YES_TOKEN_ID, originalSize: '5' }),
        openOrder({ id: '0xsell-outside', side: 'SELL', tokenId: OUTSIDE_TOKEN_ID, conditionId: MARKET_B, originalSize: '3' }),
      ],
    ]);

    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));
    const derived = deriveReservations(state);

    // YES: полное владение 20, из них 11 под SELL → доступно 9 (выводит matcher).
    expect(state.assetBalances[0]?.quantity.value().toString()).toBe('20');
    expect(derived.reservedTokens).toEqual({ [assetIdToString(YES)]: '11' });
  });

  it('BUY вне scope резервирует account-wide collateral', async () => {
    const { source, client } = buildSource();
    client.openOrders = new FakePages([
      [openOrder({ id: '0xbuy-outside', side: 'BUY', tokenId: OUTSIDE_TOKEN_ID, conditionId: MARKET_B, price: '0.5', originalSize: '10' })],
    ]);
    expect(deriveReservations(unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE))).reservedCollateral).toBe('5');
  });
});

describe('3. требует свежего прохода: запросы не атомарны', () => {
  it('сделка между чтением баланса и заявок: баланс до сделки, заявка после — отдано как есть', async () => {
    // T1 баланс 100 → T2 BUY исполнена на 20 (MATCHED, не замайнена) → T3 заявки → T4 сделки.
    const client = new FakeAccountClient();
    client.openOrders = new FakePages([[openOrder({ id: '0xbuy', side: 'BUY', price: '0.6', originalSize: '50', sizeMatched: '0' })]]);
    const reader = new (class extends FakeBalanceReader {
      public override async getCollateralBalance() {
        const balance = await super.getCollateralBalance();
        client.openOrders = new FakePages([[openOrder({ id: '0xbuy', side: 'BUY', price: '0.6', originalSize: '50', sizeMatched: '20' })]]);
        client.trades.set(
          MARKET_A,
          new FakePages([[clobTrade({ id: 'trade-inflight', takerOrderId: '0xbuy', side: 'BUY', price: '0.6', size: '20', status: TRADE_STATUS.Matched })]]),
        );
        return balance;
      }
    })();
    const { source } = buildSource(client, reader);

    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));

    // Источник не «чинит» набор: баланс прежний, остаток заявки уже уменьшен,
    // нефинальная сделка — в recentFills. 12 pUSD не видны ни в балансе, ни в
    // резервации — это окно разбирает matcher, а не источник.
    expect(state.collateralBalance.value().toString()).toBe('100');
    expect(deriveReservations(state).reservedCollateral).toBe('18');
    expect(state.recentFills.map((fill) => [String(fill.fill.id), fill.metadata.tradeStatus])).toEqual([['trade-inflight', 'MATCHED']]);
  });

  it('заявка исчезла между чтениями (отменена): в списке её нет, баланс тот же — без ошибки', async () => {
    const client = new FakeAccountClient();
    client.openOrders = new FakePages([[openOrder({ id: '0xgone' })]]);
    const reader = new (class extends FakeBalanceReader {
      public override async getCollateralBalance() {
        const balance = await super.getCollateralBalance();
        client.openOrders = new FakePages([[]]);
        return balance;
      }
    })();
    client.fetchOrderImpl = () => Promise.resolve(openOrder({ id: '0xgone', status: 'CANCELED' }));
    const { source } = buildSource(client, reader);

    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));
    const lookup = unwrap(await source.getOrderState(VENUE, ACCOUNT, orderId('0xgone')));

    // Отмена средства не двигает: весь collateral доступен; судьбу локальной
    // заявки решает адресный getOrderState.
    expect(state.openOrders).toEqual([]);
    expect(deriveReservations(state).availableCollateral).toBe('100');
    expect(lookup?.status).toBe('CANCELED');
  });

  it('резервации SELL больше баланса актива scope — не Err источника: возможно из-за порядка чтений', async () => {
    // Баланс прочитан до покупки, SELL выставлена после неё: противоречие ли
    // это, источник по одному проходу решить не может.
    const { source, client } = sourceWithClobReader({ COLLATERAL: '0', [YES_TOKEN_ID]: '5000000', [NO_TOKEN_ID]: '0' });
    client.openOrders = new FakePages([[openOrder({ id: '0xsell', side: 'SELL', tokenId: YES_TOKEN_ID, originalSize: '8' })]]);

    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));

    expect(state.assetBalances[0]?.quantity.value().toString()).toBe('5');
    expect(deriveReservations(state).reservedTokens).toEqual({ [assetIdToString(YES)]: '8' });
  });

  it('отказ на середине прохода (сделки после балансов и заявок) → Err, частичного состояния нет', async () => {
    const { source, client } = buildSource();
    client.openOrders = new FakePages([[openOrder({ id: '0xa' })]]);
    client.trades.set(MARKET_A, new FakePages([[clobTrade({ id: 'trade-1' })]], 1));

    const error = failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE));

    expect(error.message).toContain(`trades market ${MARKET_A}: pagination failed`);
    expect(client.openOrders.consumed).toBe(1);
  });
});

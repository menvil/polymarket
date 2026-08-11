/**
 * Тесты wiring bot composition (buildRepositories / buildUseCases).
 *
 * @remarks
 * Проверяют, что `IReconciliationIssueRepository` реально создаётся в
 * composition root и прокидывается в `PlaceOrderUseCase` / `ProcessFillUseCase`:
 * manual reconciliation paths в paper/live режиме должны писать queryable
 * issues, а не уходить в optional no-op ветку. Проверка поведенческая —
 * через реальные in-memory репозитории, без доступа к private deps.
 */
import Decimal from 'decimal.js';
import type { IClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { IExchangeClient } from '@polymarket/ports';
import type { RiskParams } from '@polymarket/risk';
import { Ok } from '@polymarket/result';
import {
  parseAccountId,
  asOrderId,
  asFillId,
  asMarketId,
  asInstrumentId,
  asPolymarketCtfToken,
  AssetIdHelpers,
  KnownVenues,
} from '@polymarket/ids';
import { Portfolio, asPortfolioId } from '@polymarket/portfolio';
import { Balance, Money, Fee, Price, Quantity, TimestampService } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/value-objects';
import { Order } from '@polymarket/order';
import { Fill } from '@polymarket/fill';
import { buildRepositories } from '../../src/bot/buildRepositories.js';
import { buildProcessFillUseCase, buildOrderUseCases } from '../../src/bot/buildUseCases.js';
import type { CoreInfra } from '../../src/bot/buildCoreInfra.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');
const ACCOUNT_ID = parseAccountId('venue:POLYMARKET:test-account')!;
const TOKEN_ID_RAW = '123456789012345678901234567890';
const ASSET = asPolymarketCtfToken(TOKEN_ID_RAW)!;
const INSTRUMENT_ID = asInstrumentId(TOKEN_ID_RAW)!;
const MARKET_ID = asMarketId('market-test')!;

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn<ILogger, []>().mockReturnThis() as unknown as ILogger['child'],
  };
}

function makeInfra(): CoreInfra {
  const clock: IClock = { now: () => new Date(FIXED_NOW.getTime()) };
  const eventBus: IEventBus = {
    publish: jest.fn().mockResolvedValue(Ok(undefined)) as unknown as IEventBus['publish'],
    publishAll: jest.fn().mockResolvedValue(Ok(undefined)) as unknown as IEventBus['publishAll'],
    publishOrThrow: jest.fn().mockResolvedValue(undefined) as unknown as IEventBus['publishOrThrow'],
    publishAllOrThrow: jest.fn().mockResolvedValue(undefined) as unknown as IEventBus['publishAllOrThrow'],
    subscribe: jest.fn().mockReturnValue(() => {}) as unknown as IEventBus['subscribe'],
  };
  return { clock, logger: makeLogger(), eventBus };
}

function makeTimestamp(): Timestamp {
  const r = TimestampService.create(FIXED_NOW.getTime());
  if (!r.ok) throw new Error('Failed to create timestamp');
  return r.value;
}

/** Сидирует Portfolio с балансом 1000 USDC в portfolioStore */
/** Сидирует Portfolio; `reserved` — уже зарезервированная сумма USDC (для cancel-сценариев) */
function seedPortfolio(
  portfolioStore: ReturnType<typeof buildRepositories>['portfolioStore'],
  reserved = '0',
): Portfolio {
  const result = Portfolio.create({
    id: asPortfolioId('portfolio:venue:POLYMARKET:test-account'),
    accountId: ACCOUNT_ID,
    balance: Balance.of(
      Money.of(new Decimal('1000'), 'USDC'),
      Money.of(new Decimal(reserved), 'USDC'),
      ACCOUNT_ID,
      KnownVenues.POLYMARKET,
    ),
  });
  if (!result.ok) throw new Error('Failed to create portfolio');
  portfolioStore.save(result.value, 0);
  return result.value;
}

const RISK_PARAMS: RiskParams = {
  maxOpenOrders: 20,
  maxOrderNotional: Money.of(new Decimal('500'), 'USDC'),
  maxPositionSize: Quantity.of(new Decimal('100')),
  maxTotalExposure: Money.of(new Decimal('2000'), 'USDC'),
  minAvailableBalance: Money.of(new Decimal('1'), 'USDC'),
  // minTimeToExpiryMs НЕ задаём: без marketCatalog в этих тестах expiry-лимит
  // fail-closed заблокировал бы BUY (RISK_INPUT_INCOMPLETE). Тесты не про expiry.
};

// ── Тесты ─────────────────────────────────────────────────────────────────────

describe('buildRepositories', () => {
  it('возвращает reconciliationIssueRepo (smoke: add + listOpen)', async () => {
    const repos = buildRepositories();

    expect(repos.reconciliationIssueRepo).toBeDefined();

    await repos.reconciliationIssueRepo.add({
      id: 'smoke-issue',
      type: 'VENUE_LOCAL_ORDER_DESYNC',
      status: 'OPEN',
      reason: 'smoke test',
      createdAt: new Date(FIXED_NOW.getTime()),
    });
    const open = await repos.reconciliationIssueRepo.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe('smoke-issue');
  });

  it('возвращает orderSubmissionRepo (submission guard)', () => {
    const repos = buildRepositories();
    expect(repos.orderSubmissionRepo).toBeDefined();
  });
});

describe('buildOrderUseCases — wiring orderSubmissionRepo (submission guard)', () => {
  it('повторный execute() с тем же clientOrderId после committed submit не делает второй submit', async () => {
    const infra = makeInfra();
    const repos = buildRepositories();
    const portfolio = seedPortfolio(repos.portfolioStore);

    const submitOrder = jest.fn().mockResolvedValue(
      Ok({
        status: 'OPEN',
        orderId: asOrderId('0xvenue-committed')!,
        effectiveSize: Quantity.of(new Decimal('5')),
        remainingSize: Quantity.of(new Decimal('5')),
      }),
    ) as unknown as IExchangeClient['submitOrder'];
    const cancelOrder = jest.fn().mockResolvedValue(Ok({ status: 'CANCELLED' })) as unknown as IExchangeClient['cancelOrder'];
    const exchangeClient: IExchangeClient = {
      submitOrder,
      cancelOrder,
      getOpenOrders: jest.fn().mockResolvedValue(Ok([])) as unknown as IExchangeClient['getOpenOrders'],
      getTrades: jest.fn().mockResolvedValue(Ok([])) as unknown as IExchangeClient['getTrades'],
    };

    const { orderedEventOutbox } = buildProcessFillUseCase({ infra, repos });
    const { placeOrderUseCase } = buildOrderUseCases({ infra, repos, exchangeClient, riskParams: RISK_PARAMS, orderedEventOutbox });
    const input = {
      orderId: asOrderId('client-dup-1')!,
      accountId: ACCOUNT_ID,
      asset: ASSET,
      instrumentId: INSTRUMENT_ID,
      side: 'BUY' as const,
      price: Price.of(new Decimal('0.5')),
      size: Quantity.of(new Decimal('5')),
      portfolio,
      openOrdersCount: 0,
    };

    const first = await placeOrderUseCase.execute(input);
    expect(first.ok).toBe(true);

    const second = await placeOrderUseCase.execute(input);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toBe('0xvenue-committed');

    // submitOrder вызван РОВНО один раз (второй execute короткозамкнулся), cancel не вызван.
    expect((submitOrder as ReturnType<typeof jest.fn>).mock.calls.length).toBe(1);
    expect(cancelOrder).not.toHaveBeenCalled();
  });
});

describe('buildOrderUseCases — wiring reconciliationIssues в PlaceOrderUseCase', () => {
  it('UNKNOWN submit outcome создаёт SUBMIT_UNKNOWN_OUTCOME issue в repos.reconciliationIssueRepo', async () => {
    const infra = makeInfra();
    const repos = buildRepositories();
    const portfolio = seedPortfolio(repos.portfolioStore);

    const venueOrderId = asOrderId('0xvenue-unknown')!;
    const exchangeClient: IExchangeClient = {
      submitOrder: jest.fn().mockResolvedValue(
        Ok({
          status: 'UNKNOWN',
          reason: 'ambiguous venue response',
          orderId: venueOrderId,
          effectiveSize: Quantity.of(new Decimal('5')),
        }),
      ) as unknown as IExchangeClient['submitOrder'],
      cancelOrder: jest.fn().mockResolvedValue(Ok({ status: 'CANCELLED' })) as unknown as IExchangeClient['cancelOrder'],
      getOpenOrders: jest.fn().mockResolvedValue(Ok([])) as unknown as IExchangeClient['getOpenOrders'],
      getTrades: jest.fn().mockResolvedValue(Ok([])) as unknown as IExchangeClient['getTrades'],
    };

    const { orderedEventOutbox } = buildProcessFillUseCase({ infra, repos });
    const { placeOrderUseCase } = buildOrderUseCases({
      infra,
      repos,
      exchangeClient,
      riskParams: RISK_PARAMS,
      orderedEventOutbox,
    });

    const result = await placeOrderUseCase.execute({
      orderId: asOrderId('client-order-1')!,
      accountId: ACCOUNT_ID,
      asset: ASSET,
      instrumentId: INSTRUMENT_ID,
      side: 'BUY',
      price: Price.of(new Decimal('0.5')),
      size: Quantity.of(new Decimal('5')),
      portfolio,
      openOrdersCount: 0,
    });

    expect(result.ok).toBe(false);

    // Wiring работает: issue записана в РЕАЛЬНЫЙ repo из buildRepositories.
    const open = await repos.reconciliationIssueRepo.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]?.type).toBe('SUBMIT_UNKNOWN_OUTCOME');
    expect(open[0]?.id).toBe('reconciliation:submit:0xvenue-unknown:unknown');
    // createdAt берётся из infra.clock — детерминирован относительно приложения.
    expect(open[0]?.createdAt.toISOString()).toBe(FIXED_NOW.toISOString());
  });
});

describe('buildOrderUseCases — wiring reconciliationIssues в CancelOrderUseCase', () => {
  it('UNKNOWN_RETRY_NEEDED после local cancel создаёт CANCEL_UNKNOWN_OUTCOME issue в repos.reconciliationIssueRepo', async () => {
    const infra = makeInfra();
    const repos = buildRepositories();
    // reserved 2.5 = BUY 5 @ 0.5 — cancel всегда release'ит резервацию после
    // CAS save; без неё release упал бы и создал ВТОРУЮ (release-failed) issue.
    seedPortfolio(repos.portfolioStore, '2.5');

    // Существующий OPEN ордер — cancel сначала отменяет его локально (CAS save),
    // и только потом получает ambiguous ответ от venue.
    const venueOrderId = asOrderId('0xvenue-cancel')!;
    const orderResult = Order.create({
      id: venueOrderId,
      asset: ASSET,
      side: 'BUY',
      price: Price.of(new Decimal('0.5')),
      size: Quantity.of(new Decimal('5')),
      timestamp: makeTimestamp(),
    });
    if (!orderResult.ok) throw new Error('Failed to create order');
    const acceptResult = orderResult.value.accept();
    if (!acceptResult.ok) throw new Error('Failed to accept order');
    acceptResult.value.pullEvents();
    const saveResult = await repos.orderRepo.save(acceptResult.value, 0);
    if (!saveResult.ok) throw new Error('Failed to save order');

    const exchangeClient: IExchangeClient = {
      submitOrder: jest.fn().mockResolvedValue(
        Ok({
          status: 'OPEN',
          orderId: venueOrderId,
          effectiveSize: Quantity.of(new Decimal('5')),
          remainingSize: Quantity.of(new Decimal('5')),
        }),
      ) as unknown as IExchangeClient['submitOrder'],
      cancelOrder: jest.fn().mockResolvedValue(
        Ok({ status: 'UNKNOWN_RETRY_NEEDED', reason: 'venue timeout during cancel' }),
      ) as unknown as IExchangeClient['cancelOrder'],
      getOpenOrders: jest.fn().mockResolvedValue(Ok([])) as unknown as IExchangeClient['getOpenOrders'],
      getTrades: jest.fn().mockResolvedValue(Ok([])) as unknown as IExchangeClient['getTrades'],
    };

    const { orderedEventOutbox } = buildProcessFillUseCase({ infra, repos });
    const { cancelOrderUseCase } = buildOrderUseCases({
      infra,
      repos,
      exchangeClient,
      riskParams: RISK_PARAMS,
      orderedEventOutbox,
    });

    const result = await cancelOrderUseCase.execute({
      orderId: venueOrderId,
      accountId: ACCOUNT_ID,
      reason: 'test cancel',
    });

    // Локальный cancel committed → Ok, ambiguous venue outcome → queryable issue.
    expect(result.ok).toBe(true);
    const open = await repos.reconciliationIssueRepo.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]?.type).toBe('CANCEL_UNKNOWN_OUTCOME');
    expect(open[0]?.id).toBe('reconciliation:cancel:0xvenue-cancel:unknown');
    expect(open[0]?.reason).toBe('venue timeout during cancel');
    expect(open[0]?.orderId).toBe(venueOrderId);
    // createdAt берётся из infra.clock (buildOrderUseCases прокидывает clock).
    expect(open[0]?.createdAt.toISOString()).toBe(FIXED_NOW.toISOString());
  });
});

describe('buildProcessFillUseCase — wiring reconciliationIssues в ProcessFillUseCase', () => {
  it('ORDER_PORTFOLIO_DESYNC (portfolio отсутствует после сохранения Order) создаёт issue в repos.reconciliationIssueRepo', async () => {
    const infra = makeInfra();
    // Portfolio НЕ сидируется: applyFill упадёт ПОСЛЕ saveSync обновлённого
    // Order → ветка markReconciliationRequired + reconciliation issue.
    const repos = buildRepositories();

    const venueOrderId = asOrderId('0xvenue-filled')!;
    const orderResult = Order.create({
      id: venueOrderId,
      asset: ASSET,
      side: 'BUY',
      price: Price.of(new Decimal('0.5')),
      size: Quantity.of(new Decimal('5')),
      timestamp: makeTimestamp(),
    });
    if (!orderResult.ok) throw new Error('Failed to create order');
    const acceptResult = orderResult.value.accept();
    if (!acceptResult.ok) throw new Error('Failed to accept order');
    acceptResult.value.pullEvents();
    const saveResult = await repos.orderRepo.save(acceptResult.value, 0);
    if (!saveResult.ok) throw new Error('Failed to save order');

    const fillResult = Fill.create({
      id: asFillId('fill-desync-1')!,
      orderId: venueOrderId,
      accountId: ACCOUNT_ID,
      venueId: KnownVenues.POLYMARKET,
      marketId: MARKET_ID,
      tokenId: ASSET,
      settlementAssetId: AssetIdHelpers.USDC,
      price: Price.of(new Decimal('0.5')),
      size: Quantity.of(new Decimal('5')),
      side: 'BUY',
      timestamp: makeTimestamp(),
      fee: Fee.zero(AssetIdHelpers.USDC),
    });
    if (!fillResult.ok) throw new Error('Failed to create fill');

    const { processFillUseCase } = buildProcessFillUseCase({ infra, repos });
    const result = await processFillUseCase.execute(fillResult.value);

    expect(result.ok).toBe(false);
    // Fill помечен терминально в processed-fill repo…
    expect(await repos.processedFillRepo.getStatus(fillResult.value.id)).toBe('RECONCILIATION_REQUIRED');
    // …и wiring работает: queryable issue записана в РЕАЛЬНЫЙ repo.
    const open = await repos.reconciliationIssueRepo.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]?.type).toBe('ORDER_PORTFOLIO_DESYNC');
    expect(open[0]?.id).toBe('reconciliation:fill:fill-desync-1:order-portfolio-desync');
    expect(open[0]?.fillId).toBe(fillResult.value.id);
    expect(open[0]?.orderId).toBe(venueOrderId);
    // createdAt берётся из infra.clock (buildProcessFillUseCase прокидывает clock).
    expect(open[0]?.createdAt.toISOString()).toBe(FIXED_NOW.toISOString());
  });
});

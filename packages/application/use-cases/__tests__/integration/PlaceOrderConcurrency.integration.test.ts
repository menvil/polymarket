/**
 * Регрессия: concurrency-контракт пре-трейд риск-проверки под keyed mutex.
 *
 * @remarks
 * Проверяет НЕПОСРЕДСТВЕННО параллельные `execute()` (через `Promise.all`) на
 * реальных компонентах (реальный `InMemoryKeyedMutex`, `PortfolioService` поверх
 * настоящего `Portfolio`, реальный submission journal, реальный
 * `OrderRiskChecker`):
 *
 * 1. Два BUY одного аккаунта на РАЗНЫХ инструментах по 60 при
 *    `maxTotalExposure = 100`: общий account-lock сериализует их, второй видит
 *    `portfolio.balance.reserved()` первого → проходит ровно один.
 * 2. Два BUY одного инструмента, совместно превышающих `maxPositionSize`:
 *    второй видит pending BUY-резервацию первого (submission journal) → проходит
 *    ровно один.
 *
 * Отличие от последовательного теста в `PlaceOrderUseCase.test.ts` — здесь
 * `execute()` запускаются реально параллельно, и корректность обеспечивается
 * сериализацией внутри mutex, а не порядком вызовов.
 */
import { MessageMetadataGenerator } from '@polymarket/messages';
import { unsafeRunId as unsafeRunIdM003 } from '@polymarket/ids';
import { describe, it, expect, beforeEach } from '@jest/globals';
import { NoOpLogger } from '@polymarket/logger';
import { Ok } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import {
  accountIdFromVenue,
  KnownVenues,
  asOrderId,
  assetIdToInstrumentId,
} from '@polymarket/ids';
import type { AssetId, OrderId } from '@polymarket/ids';
import { OutcomePrice, Quantity, Money } from '@polymarket/value-objects';
import { Balance } from '@polymarket/value-objects/balance';
import { Portfolio, asPortfolioId } from '@polymarket/portfolio';
import type { IExchangeClient, SubmitOrderParams, SubmitOrderResult } from '@polymarket/ports';
import { OrderRiskChecker, RiskPolicy } from '@polymarket/risk';
import type { RiskParams } from '@polymarket/risk';
import Decimal from 'decimal.js';

import { PlaceOrderUseCase } from '../../src/PlaceOrderUseCase.js';
import type { PlaceOrderDeps, PlaceOrderInput } from '../../src/PlaceOrderUseCase.js';
import { PortfolioService } from '../../src/services/PortfolioService.js';
import { InMemoryOrderRepository } from '../../../../infrastructure/in-memory/src/InMemoryOrderRepository.js';
import { InMemoryKeyedMutex } from '../../../../infrastructure/in-memory/src/InMemoryKeyedMutex.js';
import { InMemoryOrderedEventOutbox } from '../../../../infrastructure/in-memory/src/InMemoryOrderedEventOutbox.js';
import { InMemoryOrderSubmissionRepository } from '../../../../infrastructure/in-memory/src/InMemoryOrderSubmissionRepository.js';
import { InMemoryPortfolioStore } from '../../../../infrastructure/in-memory/src/InMemoryPortfolioStore.js';

// ── Константы ──────────────────────────────────────────────────────────────────

const LOGGER = new NoOpLogger();
const VENUE_ID = KnownVenues.POLYMARKET;

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

const ACCOUNT_ID = unwrap(accountIdFromVenue(VENUE_ID, 'concurrency-user'));

function tokenAsset(tokenId: string): AssetId {
  return { type: 'POLYMARKET_CTF_TOKEN', tokenId } as unknown as AssetId;
}
const ASSET_A = tokenAsset('token-concurrency-A');
const ASSET_B = tokenAsset('token-concurrency-B');
const INSTRUMENT_A = assetIdToInstrumentId(ASSET_A)!;
const INSTRUMENT_B = assetIdToInstrumentId(ASSET_B)!;

/** Portfolio с заданным available USDC и 0 reserved. */
function makePortfolio(availableUsdc: string): Portfolio {
  return unwrap(Portfolio.create({
    id: asPortfolioId('portfolio-concurrency')!,
    accountId: ACCOUNT_ID,
    balance: Balance.withZeroReserved(Money.of(new Decimal(availableUsdc), 'USDC'), ACCOUNT_ID, VENUE_ID),
  }));
}

/**
 * Exchange client, возвращающий РАЗНЫЙ venueOrderId на каждый clientOrderId
 * (иначе два committed ордера столкнулись бы в обратном индексе submission repo).
 */
function makeExchangeClient(): IExchangeClient {
  return {
    submitOrder: (params: SubmitOrderParams): Promise<Result<SubmitOrderResult, never>> =>
      Promise.resolve(Ok({
        status: 'OPEN',
        orderId: `venue-${params.clientOrderId}` as unknown as OrderId,
        effectiveSize: params.size,
        remainingSize: params.size,
      })) as Promise<Result<SubmitOrderResult, never>>,
    cancelOrder: () => Promise.resolve(Ok({ status: 'CANCELLED' })),
    getOpenOrders: () => Promise.resolve(Ok([])),
    getTrades: () => Promise.resolve(Ok([])),
  };
}

/** Детерминированный canonical-генератор metadata для тестовых deps (M-003). */
function makeMetadataGenerator(): MessageMetadataGenerator {
  return new MessageMetadataGenerator({
    clock: { now: () => new Date('2024-01-01T00:00:00.000Z') },
    runId: unsafeRunIdM003('testrun1'),
  });
}

describe('PlaceOrder concurrency (integration) — risk projection под keyed mutex', () => {
  let orderRepo: InMemoryOrderRepository;
  let portfolioStore: InMemoryPortfolioStore;
  let portfolioService: PortfolioService;
  let keyedMutex: InMemoryKeyedMutex;
  let submissions: InMemoryOrderSubmissionRepository;
  let orderedEventOutbox: InMemoryOrderedEventOutbox;

  beforeEach(() => {
    orderRepo = new InMemoryOrderRepository();
    portfolioStore = new InMemoryPortfolioStore();
    portfolioService = new PortfolioService(portfolioStore, LOGGER);
    keyedMutex = new InMemoryKeyedMutex();
    submissions = new InMemoryOrderSubmissionRepository();
    orderedEventOutbox = new InMemoryOrderedEventOutbox({ publish: () => Promise.resolve(), logger: LOGGER });
  });

  function buildDeps(riskParams: RiskParams): PlaceOrderDeps {
    const policy = unwrap(RiskPolicy.create(riskParams));
    return {
      metadataGenerator: makeMetadataGenerator(),
      riskChecker: new OrderRiskChecker(policy, LOGGER),
      orderRepo,
      portfolioService,
      exchangeClient: makeExchangeClient(),
      orderStateStore: orderRepo,
      keyedMutex,
      orderedEventOutbox,
      submissions,
      clock: { now: () => new Date() },
      logger: LOGGER,
    };
  }

  function makeInput(overrides: {
    orderId: string;
    asset: AssetId;
    instrumentId: typeof INSTRUMENT_A;
    price: string;
    size: string;
    portfolio: Portfolio;
  }): PlaceOrderInput {
    return {
      orderId: asOrderId(overrides.orderId)!,
      accountId: ACCOUNT_ID,
      asset: overrides.asset,
      instrumentId: overrides.instrumentId,
      side: 'BUY',
      price: OutcomePrice.of(new Decimal(overrides.price)),
      size: Quantity.of(new Decimal(overrides.size)),
      portfolio: overrides.portfolio,
      openOrdersCount: 0,
    };
  }

  it('два параллельных BUY на РАЗНЫХ инструментах по 60 при maxTotalExposure=100 → проходит ровно один', async () => {
    const portfolio = makePortfolio('1000');
    portfolioStore.save(portfolio, 0);
    const useCase = new PlaceOrderUseCase(buildDeps({ maxTotalExposure: Money.of(new Decimal('100'), 'USDC') }));

    // Оба notional = 60 (price 0.6 × size 100). costBasis 0 + reserved(другого) 60 + new 60 = 120 > 100.
    const [rA, rB] = await Promise.all([
      useCase.execute(makeInput({ orderId: 'order-A', asset: ASSET_A, instrumentId: INSTRUMENT_A, price: '0.6', size: '100', portfolio })),
      useCase.execute(makeInput({ orderId: 'order-B', asset: ASSET_B, instrumentId: INSTRUMENT_B, price: '0.6', size: '100', portfolio })),
    ]);

    const passed = [rA, rB].filter((r) => r.ok).length;
    expect(passed).toBe(1);
    // Отклонённый — именно по total exposure.
    const rejected = [rA, rB].find((r) => !r.ok);
    if (rejected && !rejected.ok) {
      expect((rejected.error as { riskCode?: string }).riskCode).toBe('TOTAL_EXPOSURE_EXCEEDED');
    }
    // Итоговый reserved = ровно один ордер (60), а не оба.
    const finalPortfolio = portfolioService.getPortfolio(ACCOUNT_ID);
    expect(finalPortfolio?.balance.reserved().value().toString()).toBe('60');
  });

  it('два параллельных BUY одного инструмента, совместно превышающих maxPositionSize=100 → проходит ровно один', async () => {
    const portfolio = makePortfolio('1000');
    portfolioStore.save(portfolio, 0);
    const useCase = new PlaceOrderUseCase(buildDeps({ maxPositionSize: Quantity.of(new Decimal('100')) }));

    // Каждый: price 0.5 × size 60. pending первого = 30 USDC / 0.5 = 60 токенов.
    // Второй: 0 (filled) + 60 (pending) + 60 (new) = 120 > 100 → reject.
    const [r1, r2] = await Promise.all([
      useCase.execute(makeInput({ orderId: 'order-1', asset: ASSET_A, instrumentId: INSTRUMENT_A, price: '0.5', size: '60', portfolio })),
      useCase.execute(makeInput({ orderId: 'order-2', asset: ASSET_A, instrumentId: INSTRUMENT_A, price: '0.5', size: '60', portfolio })),
    ]);

    const passed = [r1, r2].filter((r) => r.ok).length;
    expect(passed).toBe(1);
    const rejected = [r1, r2].find((r) => !r.ok);
    if (rejected && !rejected.ok) {
      expect((rejected.error as { riskCode?: string }).riskCode).toBe('POSITION_LIMIT_EXCEEDED');
    }
  });
});

/**
 * Интеграционный тест — одновременная торговля на двух рынках.
 *
 * @remarks
 * Проверяет, что StrategyScheduler корректно маршрутизирует market data events
 * к двум независимым стратегиям, каждая торгующая на своём инструменте.
 *
 * Запуск:
 * ```bash
 * # Из apps/bot/:
 * npx jest --testPathPattern=integration/backtest-multi-market --no-coverage --verbose
 * ```
 *
 * Два снапшота из разных 5-минутных Bitcoin рынков воспроизводятся последовательно
 * через общий EventBus. Стратегии зарегистрированы на разных instrumentId,
 * scheduler маршрутизирует BOOK_UPDATED → правильная стратегия → ордера.
 *
 * Ожидаемый результат:
 * - Обе стратегии размещают ордера на своих инструментах
 * - Portfolio общий: баланс USDC расходуется на оба рынка
 * - Позиции разделены по instrumentId
 * - Баланс не обнуляется
 */

import path from 'node:path';
import Decimal from 'decimal.js';
import { ReplayClock } from '@polymarket/time';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { EventBus } from '@polymarket/event-bus';
import { BookUpdateHandler } from '@polymarket/handlers';
import type { IBookRegistry } from '@polymarket/handlers';
import { OrderBook } from '@polymarket/order-book';
import type { OrderBook as OrderBookType } from '@polymarket/order-book';
import { asInstrumentId, asMarketId, parseAccountId, KnownVenues, asPolymarketCtfToken, assetIdToString } from '@polymarket/ids';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { InstrumentInfo } from '@polymarket/ports';
import { Portfolio, asPortfolioId } from '@polymarket/portfolio';
import { Balance, Money, Price, Quantity, TimestampService } from '@polymarket/value-objects';
import { BacktestEngine } from '@polymarket/backtesting';
import { JsonlSnapshotReader } from '@polymarket/snapshot-readers';
import { buildRepositories } from '../../src/bot/buildRepositories.js';
import { buildProcessFillUseCase, buildOrderUseCases } from '../../src/bot/buildUseCases.js';
import { buildPaperInfra, buildPaperSimulator } from '../../src/bot/buildPaperMode.js';
import { buildMarketData } from '../../src/bot/buildMarketData.js';
import { buildStrategyEngine } from '../../src/bot/buildStrategyEngine.js';
import { createStrategy } from '../../src/strategyFactory.js';
import type { StrategyConfig } from '../../src/strategyFactory.js';
import { InMemoryMarketCatalog } from '../../src/InMemoryMarketCatalog.js';
import type { RiskParams } from '@polymarket/risk';
import type { DumbStrategyConfig } from '../../src/strategies/DumbStrategy.js';

jest.setTimeout(120_000);

// ── Конфиг ─────────────────────────────────────────────────────────────────

const SNAPSHOTS_DIR = path.resolve(
  __dirname,
  '../../../../packages/apps/collect-data/snapshots/2026-03-11',
);

/** Рынок A: BTC 6:15PM-6:30PM */
const SNAPSHOT_A = path.join(
  SNAPSHOTS_DIR,
  'Bitcoin_Up_or_Down_-_March_11_615PM-630PM_ET___0x947e16d2f707b2d66cbf3d603b59f2e81a124d.jsonl',
);

/** Рынок B: BTC 6:35PM-6:40PM */
const SNAPSHOT_B = path.join(
  SNAPSHOTS_DIR,
  'Bitcoin_Up_or_Down_-_March_11_635PM-640PM_ET___0xd63862dcb53670f87c4dda7bf5b9a014703b56.jsonl',
);

const OUTCOME_INDEX = 1 as 0 | 1; // NO token

const DUMB_CONFIG: DumbStrategyConfig = {
  orderSize: new Decimal('5'),
  buyOffsetPct: new Decimal('1'),
  profitMarginPct: new Decimal('1'),
  repriceThreshold: new Decimal('0.05'),
};

const INITIAL_BALANCE = new Decimal('1000');
const ACCOUNT_ID_RAW = 'venue:POLYMARKET:backtest-multi';

// ── IBookRegistry ──────────────────────────────────────────────────────────

class SimpleBookRegistry implements IBookRegistry {
  private readonly _books = new Map<string, OrderBookType>();

  private _key(mId: MarketId, tId: InstrumentId): string {
    return `${String(mId)}:${String(tId)}`;
  }

  get(mId: MarketId, tId: InstrumentId): OrderBookType | undefined {
    return this._books.get(this._key(mId, tId));
  }

  getOrCreate(mId: MarketId, tId: InstrumentId): OrderBookType {
    const key = this._key(mId, tId);
    let book = this._books.get(key);
    if (!book) {
      book = OrderBook.create(mId, String(tId));
      this._books.set(key, book);
    }
    return book;
  }

  delete(mId: MarketId, tId: InstrumentId): void {
    this._books.delete(this._key(mId, tId));
  }

  deleteMarket(mId: MarketId): void {
    const prefix = `${String(mId)}:`;
    for (const key of [...this._books.keys()]) {
      if (key.startsWith(prefix)) this._books.delete(key);
    }
  }
}

// ── Хелпер: извлечь meta из снапшота ────────────────────────────────────────

interface SnapshotMeta {
  readonly marketId: MarketId;
  readonly instrumentId: InstrumentId;
}

async function readMeta(filePath: string, outcomeIndex: 0 | 1): Promise<SnapshotMeta> {
  const reader = new JsonlSnapshotReader(filePath);
  try {
    for await (const line of reader.readLines()) {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (raw['t'] === 'meta') {
        const marketId = asMarketId(raw['marketId'] as string);
        const tokenIds = raw['tokenIds'] as string[];
        const instrumentId = asInstrumentId(tokenIds[outcomeIndex]!);
        if (!marketId || !instrumentId) throw new Error(`Invalid meta in ${filePath}`);
        return { marketId, instrumentId };
      }
    }
  } finally {
    await reader.close();
  }
  throw new Error(`No meta line found in ${filePath}`);
}

// ── Тест ──────────────────────────────────────────────────────────────────

describe('Backtest — два рынка одновременно', () => {
  it('торгует на двух инструментах, разделяя баланс', async () => {
    // ── Meta из обоих снапшотов ──────────────────────────────────────────
    const [metaA, metaB] = await Promise.all([
      readMeta(SNAPSHOT_A, OUTCOME_INDEX),
      readMeta(SNAPSHOT_B, OUTCOME_INDEX),
    ]);

    expect(String(metaA.instrumentId)).not.toBe(String(metaB.instrumentId));

    const assetA = asPolymarketCtfToken(String(metaA.instrumentId))!;
    const assetB = asPolymarketCtfToken(String(metaB.instrumentId))!;

    // ── Инфраструктура ──────────────────────────────────────────────────

    const replayClock = new ReplayClock(new Date(0));
    const logger = new ConsoleLogger(replayClock, LogLevel.WARN);
    const eventBus = new EventBus(logger);
    const infra = { clock: replayClock, logger, eventBus };

    const repos = buildRepositories();
    const { portfolioStore } = repos;
    const accountId = parseAccountId(ACCOUNT_ID_RAW)!;

    // ── Каталог инструментов (оба рынка) ─────────────────────────────────

    const marketCatalog = new InMemoryMarketCatalog();
    const expiresAt = TimestampService.create(Date.now() + 86400_000);
    if (!expiresAt.ok) throw new Error('bad timestamp');

    const baseInfo = {
      tickSize: Price.of(new Decimal('0.001')),
      minOrderSize: Quantity.of(new Decimal('1')),
      minOrderValue: Quantity.of(new Decimal('1')),
      active: true,
      expiresAt: expiresAt.value,
    };

    const infoA: InstrumentInfo = {
      ...baseInfo,
      instrumentId: metaA.instrumentId,
      marketId: metaA.marketId,
    };
    const infoB: InstrumentInfo = {
      ...baseInfo,
      instrumentId: metaB.instrumentId,
      marketId: metaB.marketId,
    };
    marketCatalog.register(infoA);
    marketCatalog.register(infoB);

    // ── Paper infra (один PaperExchangeClient для двух рынков) ────────────

    const { mockClient } = buildPaperInfra({ clock: replayClock });
    const { processFillUseCase, portfolioService } = buildProcessFillUseCase({ infra, repos });

    const paperConfig = {
      fillOnBookCrossing: true,
      fillOnTape: true,
      fillAtOrderPrice: true,
    };

    // Создаём simulator и exchange client с первым рынком
    const { simulator, exchangeClient } = buildPaperSimulator({
      mockClient,
      processFillUseCase,
      eventBus,
      clock: replayClock,
      logger,
      instrumentId: metaA.instrumentId,
      marketId: metaA.marketId,
      accountId,
      asset: assetA,
      config: paperConfig,
    });

    // Регистрируем второй рынок для мульти-маркет маршрутизации
    exchangeClient.registerMarket(metaB.instrumentId, metaB.marketId, accountId, assetB);

    const riskParams: RiskParams = {
      maxOpenOrders: 40,
      maxOrderNotional: new Decimal('500'),
      maxPositionSize: new Decimal('100'),
      maxTotalExposure: new Decimal('2000'),
      minAvailableBalance: new Decimal('1'),
      minTimeToExpiryMs: 0,
    };

    const orderUseCases = buildOrderUseCases({ infra, repos, exchangeClient, riskParams });
    const useCases = { processFillUseCase, portfolioService, ...orderUseCases };

    // ── Market data + Strategy Engine ─────────────────────────────────────

    const { marketDataStore } = buildMarketData({ infra });
    const engine = buildStrategyEngine({ infra, repos, useCases, marketDataStore, marketCatalog });

    // ── Портфель ──────────────────────────────────────────────────────────

    const portfolioResult = Portfolio.create({
      id: asPortfolioId(`portfolio:${ACCOUNT_ID_RAW}`),
      accountId,
      balance: Balance.of(
        Money.of(INITIAL_BALANCE, 'USDC'),
        Money.of(new Decimal(0), 'USDC'),
        accountId,
        KnownVenues.POLYMARKET,
      ),
    });
    expect(portfolioResult.ok).toBe(true);
    if (!portfolioResult.ok) throw new Error('portfolio creation failed');
    portfolioStore.save(portfolioResult.value, 0);

    // ── BookUpdateHandler ─────────────────────────────────────────────────

    const bookRegistry = new SimpleBookRegistry();
    const bookUpdateHandler = new BookUpdateHandler(bookRegistry, eventBus, marketCatalog, logger);

    // ── Счётчик ордеров по инструментам ──────────────────────────────────
    // OrderEventBridge удаляет terminal ордера из repo, поэтому считаем через
    // ORDER_CREATED событие (содержит asset = tokenId).

    const orderCountByAsset = new Map<string, number>();
    eventBus.subscribe('ORDER_CREATED', (event) => {
      const key = assetIdToString(event.asset);
      orderCountByAsset.set(key, (orderCountByAsset.get(key) ?? 0) + 1);
    });

    // ── Запуск ────────────────────────────────────────────────────────────

    marketDataStore.start();
    engine.orderEventBridge.start();
    simulator.start();
    engine.scheduler.start();

    // Две независимые стратегии — каждая на своём инструменте
    const strategyA = createStrategy({
      type: 'dumb',
      id: 'dumb-market-A',
      params: DUMB_CONFIG,
    } as StrategyConfig);

    const strategyB = createStrategy({
      type: 'dumb',
      id: 'dumb-market-B',
      params: DUMB_CONFIG,
    } as StrategyConfig);

    const marketStub = {
      expirationMs: Date.now() + 24 * 60 * 60 * 1000,
    } as Parameters<typeof engine.scheduler.register>[0]['market'];

    // Регистрируем обе стратегии
    const [regA, regB] = await Promise.all([
      engine.scheduler.register({
        strategy: strategyA,
        instrumentId: metaA.instrumentId,
        asset: assetA,
        accountId,
        market: marketStub,
      }),
      engine.scheduler.register({
        strategy: strategyB,
        instrumentId: metaB.instrumentId,
        asset: assetB,
        accountId,
        market: marketStub,
      }),
    ]);

    expect(regA.ok).toBe(true);
    expect(regB.ok).toBe(true);

    // ── Воспроизведение обоих снапшотов ──────────────────────────────────
    // Последовательно: сначала рынок A, потом рынок B.
    // Оба прогоняются через общий EventBus → scheduler маршрутизирует
    // book events к правильной стратегии по instrumentId.

    const backtestA = new BacktestEngine(
      { filePaths: [SNAPSHOT_A], outcomeIndex: OUTCOME_INDEX },
      { bookUpdateHandler, eventBus, replayClock, logger },
    );
    const resultA = await backtestA.run();

    const backtestB = new BacktestEngine(
      { filePaths: [SNAPSHOT_B], outcomeIndex: OUTCOME_INDEX },
      { bookUpdateHandler, eventBus, replayClock, logger },
    );
    const resultB = await backtestB.run();

    // ── Остановка ─────────────────────────────────────────────────────────

    await engine.scheduler.unregister(strategyA.id);
    await engine.scheduler.unregister(strategyB.id);
    engine.scheduler.stop();
    engine.orderEventBridge.stop();
    simulator.stop();
    marketDataStore.stop();

    // ── Ждём завершения async execution pipeline ───────────────────────
    // ExecutionEngine.execute() — fire-and-forget, нужно дать microtasks завершиться.
    await new Promise((r) => setTimeout(r, 200));

    // ── Результаты ────────────────────────────────────────────────────────

    const finalPortfolio = portfolioStore.get(accountId)!;

    const available = finalPortfolio.balance.available().value();
    const reserved = finalPortfolio.balance.reserved().value();
    const pnl = available.minus(INITIAL_BALANCE);
    const pnlSign = pnl.gte(0) ? '+' : '';

    const ordersOnA = orderCountByAsset.get(assetIdToString(assetA)) ?? 0;
    const ordersOnB = orderCountByAsset.get(assetIdToString(assetB)) ?? 0;

    logger.warn('=== MULTI-MARKET BACKTEST RESULTS ===', {
      snapshotA: path.basename(SNAPSHOT_A),
      snapshotB: path.basename(SNAPSHOT_B),
    });

    logger.warn('Market A replay', {
      bookEvents: resultA.bookEvents,
      tradeEvents: resultA.tradeEvents,
      errors: resultA.errors,
      ordersCreated: ordersOnA,
    });

    logger.warn('Market B replay', {
      bookEvents: resultB.bookEvents,
      tradeEvents: resultB.tradeEvents,
      errors: resultB.errors,
      ordersCreated: ordersOnB,
    });

    logger.warn('Portfolio', {
      initialBalance: INITIAL_BALANCE.toFixed(2),
      available: available.toFixed(4),
      reserved: reserved.toFixed(4),
      pnl: `${pnlSign}${pnl.toFixed(4)} USDC`,
      openPositions: [...finalPortfolio.positions.values()].map(p => ({
        token: String(p.instrumentId).slice(0, 10),
        qty: p.quantity.value().toFixed(2),
        avgEntry: p.averageEntryPrice.value().toFixed(4),
      })),
    });

    // ── Assertions ────────────────────────────────────────────────────────

    // Оба снапшота дали события
    expect(resultA.bookEvents + resultA.tradeEvents).toBeGreaterThan(0);
    expect(resultB.bookEvents + resultB.tradeEvents).toBeGreaterThan(0);
    expect(resultA.errors).toBe(0);
    expect(resultB.errors).toBe(0);

    // Обе стратегии разместили ордера (через ORDER_CREATED события)
    expect(ordersOnA).toBeGreaterThan(0);
    expect(ordersOnB).toBeGreaterThan(0);

    // Баланс не обнулился (с учётом позиций)
    const totalPositionCost = [...finalPortfolio.positions.values()].reduce(
      (acc, p) => acc.plus(p.quantity.value().times(p.averageEntryPrice.value())),
      new Decimal(0),
    );
    const totalValue = available.plus(reserved).plus(totalPositionCost);
    expect(totalValue.toNumber()).toBeGreaterThan(900);
  });
});

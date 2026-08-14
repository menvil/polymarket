/**
 * Интеграционный тест — прогон DumbStrategy на реальном снапшоте.
 *
 * @remarks
 * Запуск:
 * ```bash
 * # Из apps/bot/:
 * npx jest --testPathPattern=integration/backtest --no-coverage --verbose
 *
 * # С кастомным снапшотом:
 * SNAPSHOT=./path/to/market.jsonl OUTCOME=1 npx jest integration/backtest --no-coverage
 * ```
 *
 * Переменные окружения:
 * - `SNAPSHOT` — путь к JSONL файлу (по умолчанию: Bitcoin_Up_or_Down 2026-03-11)
 * - `OUTCOME` — 0 (YES) или 1 (NO), по умолчанию 1
 */

import path from 'node:path';
import Decimal from 'decimal.js';
import { ReplayClock } from '@polymarket/time';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { unsafeRunId } from '@polymarket/ids';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { EventBus } from '@polymarket/event-bus';
import { BookUpdateHandler } from '@polymarket/handlers';
import { SimpleBookRegistry } from '../../src/SimpleBookRegistry.js';
import { asInstrumentId, asMarketId, parseAccountId, KnownVenues, asPolymarketCtfToken } from '@polymarket/ids';
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

jest.setTimeout(120_000); // бектест может занять до 2 минут

// ── Конфиг ─────────────────────────────────────────────────────────────────

const DEFAULT_SNAPSHOT = path.resolve(
  __dirname,
  '../../../collect-data/snapshots/2026-03-11/Bitcoin_Up_or_Down_-_March_11_6PM_ET___0xd01482826c00487c99c59e43f27f8d2f5cccc3.jsonl',
);

const SNAPSHOT_PATH = process.env['SNAPSHOT'] ?? DEFAULT_SNAPSHOT;
const OUTCOME_INDEX = (process.env['OUTCOME'] === '0' ? 0 : 1) as 0 | 1;

const DUMB_CONFIG: DumbStrategyConfig = {
  orderSize: new Decimal('5'),
  buyOffsetPct: new Decimal('1'),      // покупаем на 1% ниже refPrice
  profitMarginPct: new Decimal('1'),   // продаём на 1% выше цены входа
  repriceThreshold: new Decimal('0.05'), // переставляем если рынок ушёл вверх на 5 центов
};

const INITIAL_BALANCE = new Decimal('1000');
const ACCOUNT_ID_RAW = 'venue:POLYMARKET:backtest-account';

// ── Тест ──────────────────────────────────────────────────────────────────

describe('Backtest — DumbStrategy on snapshot', () => {
  it('replays snapshot, places orders, shows PnL', async () => {
    // ── Читаем meta из снапшота ─────────────────────────────────────────

    const metaReader = new JsonlSnapshotReader(SNAPSHOT_PATH);
    let snapshotMarketId: MarketId | undefined;
    let snapshotInstrumentId: InstrumentId | undefined;

    for await (const line of metaReader.readLines()) {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (raw['t'] === 'meta') {
        snapshotMarketId = asMarketId(raw['marketId'] as string) ?? undefined;
        const tokenIds = raw['tokenIds'] as string[];
        const tokenId = tokenIds[OUTCOME_INDEX];
        if (tokenId) snapshotInstrumentId = asInstrumentId(tokenId) ?? undefined;
        break;
      }
    }
    await metaReader.close();

    expect(snapshotMarketId).toBeDefined();
    expect(snapshotInstrumentId).toBeDefined();

    const instrumentId = snapshotInstrumentId!;
    const marketId = snapshotMarketId!;
    const asset = asPolymarketCtfToken(String(instrumentId))!;

    // ── Инфраструктура ──────────────────────────────────────────────────

    const replayClock = new ReplayClock(new Date(0));
    const logger = new ConsoleLogger(replayClock, LogLevel.WARN);
    const eventBus = new EventBus(logger);
    const infra = {
      clock: replayClock,
      logger,
      eventBus,
      metadataGenerator: new MessageMetadataGenerator({ clock: replayClock, runId: unsafeRunId('testrun1') }),
    };

    const repos = buildRepositories();
    const { portfolioStore, orderRepo } = repos;

    const accountId = parseAccountId(ACCOUNT_ID_RAW)!;

    // ── Каталог инструментов ────────────────────────────────────────────

    const marketCatalog = new InMemoryMarketCatalog();
    const expiresAtResult = TimestampService.create(Date.now() + 86400_000);
    const instrumentInfo: InstrumentInfo = {
      instrumentId,
      marketId,
      tickSize: Price.of(new Decimal('0.001')),
      minOrderSize: Quantity.of(new Decimal('1')),
      minOrderValue: Money.of(new Decimal('1'), 'USDC'),
      active: true,
      expiresAt: expiresAtResult.ok ? expiresAtResult.value : (() => { throw new Error('bad ts'); })(),
    };
    marketCatalog.register(instrumentInfo);

    // ── Chicken-and-egg ─────────────────────────────────────────────────

    const { mockClient } = buildPaperInfra({ clock: replayClock });
    const { processFillUseCase, portfolioService, orderedEventOutbox } = buildProcessFillUseCase({ infra, repos });

    const paperConfig = {
      fillOnBookCrossing: true,
      fillOnTape: true,
      fillAtOrderPrice: true,
    };

    const { simulator, exchangeClient } = buildPaperSimulator({
      mockClient,
      processFillUseCase,
      portfolioStore: repos.portfolioStore,
      eventBus,
      clock: replayClock,
      logger,
      instrumentId,
      marketId,
      accountId,
      asset,
      config: paperConfig,
    });

    const riskParams: RiskParams = {
      maxOpenOrders: 20,
      maxOrderNotional: Money.of(new Decimal('500'), 'USDC'),
      maxPositionSize: Quantity.of(new Decimal('100')),
      maxTotalExposure: Money.of(new Decimal('2000'), 'USDC'),
      minAvailableBalance: Money.of(new Decimal('1'), 'USDC'),
      // minTimeToExpiryMs НЕ задаём: timing управляет стратегия, а marketCatalog
      // в этот buildOrderUseCases не передаётся (fail-closed заблокировал бы BUY).
    };

    const orderUseCases = buildOrderUseCases({ infra, repos, exchangeClient, riskParams, orderedEventOutbox });
    const useCases = { processFillUseCase, portfolioService, ...orderUseCases };

    // ── Market data + Engine ────────────────────────────────────────────

    const { marketDataStore } = buildMarketData({ infra });
    const engine = buildStrategyEngine({ infra, repos, useCases, marketDataStore, marketCatalog });

    // ── Портфель ────────────────────────────────────────────────────────

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

    // ── BookUpdateHandler ───────────────────────────────────────────────

    const bookRegistry = new SimpleBookRegistry();
    const bookUpdateHandler = new BookUpdateHandler(bookRegistry, eventBus, infra.metadataGenerator, marketCatalog, logger);

    // ── Запуск ──────────────────────────────────────────────────────────

    marketDataStore.start();
    engine.orderEventBridge.start();
    simulator.start();
    engine.scheduler.start();

    const strategy = createStrategy({
      type: 'dumb',
      params: DUMB_CONFIG,
    } as StrategyConfig);

    const marketStub = {
      expirationMs: Date.now() + 24 * 60 * 60 * 1000,
    } as Parameters<typeof engine.scheduler.register>[0]['market'];

    const regResult = await engine.scheduler.register({
      strategy,
      instrumentId,
      asset,
      accountId,
      market: marketStub,
    });
    expect(regResult.ok).toBe(true);

    // ── Воспроизведение ─────────────────────────────────────────────────

    const backtestEngine = new BacktestEngine(
      { filePaths: [SNAPSHOT_PATH], outcomeIndex: OUTCOME_INDEX },
      { bookUpdateHandler, eventBus, metadataGenerator: infra.metadataGenerator, replayClock, logger },
    );

    const replayResult = await backtestEngine.run();

    // ── Остановка ───────────────────────────────────────────────────────

    await engine.scheduler.unregister(strategy.id);
    engine.scheduler.stop();
    engine.orderEventBridge.stop();
    simulator.stop();
    marketDataStore.stop();

    // ── Результаты ──────────────────────────────────────────────────────

    const orders = await orderRepo.getAll();
    const finalPortfolio = portfolioStore.get(accountId)!;

    const available = finalPortfolio.balance.available().value();
    const reserved = finalPortfolio.balance.reserved().value();
    const pnl = available.minus(INITIAL_BALANCE);
    const pnlSign = pnl.gte(0) ? '+' : '';

    logger.warn('=== BACKTEST RESULTS ===', {
      snapshot: path.basename(SNAPSHOT_PATH),
      outcome: OUTCOME_INDEX === 0 ? 'YES' : 'NO',
      bookEvents: replayResult.bookEvents,
      tradeEvents: replayResult.tradeEvents,
      errors: replayResult.errors,
      durationMs: replayResult.durationMs,
    });

    logger.warn('Strategy config', {
      orderSize: DUMB_CONFIG.orderSize.toNumber(),
      buyOffsetPct: DUMB_CONFIG.buyOffsetPct.toNumber(),
      profitMarginPct: DUMB_CONFIG.profitMarginPct.toNumber(),
      repriceThreshold: DUMB_CONFIG.repriceThreshold.toNumber(),
    });

    logger.warn('Orders placed', {
      count: orders.length,
      orders: orders.map(o => ({
        side: o.side,
        price: o.price.value().toFixed(4),
        size: o.size.value().toFixed(2),
        status: o.status,
      })),
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

    // Assertions — проверяем что что-то произошло
    expect(replayResult.bookEvents + replayResult.tradeEvents).toBeGreaterThan(0);
    expect(replayResult.errors).toBe(0);

    // Баланс не должен уйти в ноль (с учётом позиций — стратегия может тратить деньги на токены)
    const totalPositionCost = [...finalPortfolio.positions.values()].reduce(
      (acc, p) => acc.plus(p.quantity.value().times(p.averageEntryPrice.value())),
      new Decimal(0),
    );
    const totalValue = available.plus(reserved).plus(totalPositionCost);
    expect(totalValue.toNumber()).toBeGreaterThan(900);
  });
});

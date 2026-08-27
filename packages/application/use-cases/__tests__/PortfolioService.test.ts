/**
 * Тесты для PortfolioService — фокус на lot-based Position (Этап 3 плана миграции).
 *
 * @remarks
 * Использует реальные `Portfolio` + `InMemoryPortfolioStore` (не полное мокирование) —
 * тестирует настоящее end-to-end поведение `_applyPositionUpdate` через публичный
 * `applyFill()`. Покрывает:
 * - Открытие/накопление позиции лотами (BUY)
 * - FIFO-закрытие с realizedPnL (SELL)
 * - Известное расхождение averageEntryPrice между FIFO и blended-pool моделями
 *   на multi-lot partial close (см. docs/architecture/position-accounting.md)
 * - Reconstruction non-lot-based позиции (регрессия на найденный баг с тестовыми моками
 *   / SimplePosition от reverseFill())
 *
 * BUY/SELL fill требуют предварительной резервации (USDC/токены соответственно) —
 * `applyFill()`'s баланс-логика списывает из УЖЕ зарезервированного (`applyDebit`/
 * `releaseTokenReservation`), это не специфично для lot-based рефакторинга, но
 * обязательно для того, чтобы дойти до `_applyPositionUpdate` в тесте.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import { PortfolioService } from '../src/services/PortfolioService.js';
import { InMemoryPortfolioStore } from '../../../infrastructure/in-memory/src/InMemoryPortfolioStore.js';
import { Portfolio, SimplePosition } from '@polymarket/portfolio';
import { Position } from '@polymarket/position';
import { Balance } from '@polymarket/value-objects/balance';
import { Money, OutcomePrice, Quantity, Fee, AssetQuantity } from '@polymarket/value-objects';
import { Timestamp } from '@polymarket/timestamp';
import type { AccountId, AssetId, FillId, InstrumentId, OrderId, VenueId, MarketId } from '@polymarket/ids';
import { AssetIdHelpers } from '@polymarket/ids';
import { asPortfolioId } from '@polymarket/portfolio';
import type { Fill } from '@polymarket/fill';
import type { ILogger } from '@polymarket/logger';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): ILogger {
  const noop = () => {};
  const logger = {
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => logger,
  } as unknown as ILogger;
  return logger;
}

const ACCOUNT_ID = 'acc-portfolio-service-test' as unknown as AccountId;
const VENUE_ID = 'POLYMARKET' as unknown as VenueId;
const INSTRUMENT_ID = 'token-yes' as unknown as InstrumentId;
const TOKEN_ID = { type: 'POLYMARKET_CTF_TOKEN', tokenId: 'token-yes' } as unknown as AssetId;
const ORDER_ID = 'order-1' as unknown as OrderId;
const MARKET_ID = 'market-1' as unknown as MarketId;

function ts(ms: number): Timestamp {
  return Timestamp.of(new Decimal(ms));
}

function makeFill(overrides: {
  id: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  timestampMs: number;
  feeUSDC?: number;
}): Fill {
  const fee = overrides.feeUSDC
    ? Fee.of(new AssetQuantity(AssetIdHelpers.USDC, Quantity.of(new Decimal(overrides.feeUSDC))))
    : Fee.zero(AssetIdHelpers.USDC);
  return {
    id: overrides.id as unknown as FillId,
    orderId: ORDER_ID,
    accountId: ACCOUNT_ID,
    venueId: VENUE_ID,
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    settlementAssetId: AssetIdHelpers.USDC,
    price: OutcomePrice.of(new Decimal(overrides.price)),
    size: Quantity.of(new Decimal(overrides.size)),
    side: overrides.side,
    timestamp: ts(overrides.timestampMs),
    fee,
  } as unknown as Fill;
}

function makePortfolio(tokenReservations?: ReadonlyMap<InstrumentId, Quantity>): Portfolio {
  const balance = Balance.withZeroReserved(Money.of(new Decimal(100_000), 'USDC'), ACCOUNT_ID, VENUE_ID);
  const result = Portfolio.create({
    id: asPortfolioId('portfolio-test'),
    accountId: ACCOUNT_ID,
    balance,
    tokenReservations,
  });
  if (!result.ok) throw new Error('Failed to create test Portfolio');
  return result.value;
}

/**
 * Резервирует токены под SELL (нормальный жизненный цикл: place SELL order → reserve →
 * fill → release). `applyFill()`'s SELL-ветка ВСЕГДА строго снимает резервацию ДО
 * `_applyPositionUpdate` — без предварительного reserve любой SELL fill падает на
 * releaseTokenReservation раньше, чем достигает position-логики.
 */
function reserveTokens(service: PortfolioService, qty: number): void {
  const result = service.reserveTokensForOrder(ACCOUNT_ID, INSTRUMENT_ID, Quantity.of(new Decimal(qty)));
  if (!result.ok) throw new Error(`Failed to reserve tokens in test setup: ${result.error.message}`);
}

/**
 * Резервирует USDC под BUY (нормальный жизненный цикл: place BUY order → reserve →
 * fill → applyDebit). `applyFill()`'s BUY-ветка списывает notional через `applyDebit`,
 * который снимает из ЗАРЕЗЕРВИРОВАННОГО баланса — без предварительного reserve любой
 * BUY fill падает на balance-шаге раньше, чем достигает position-логики.
 */
function reserveUSDC(service: PortfolioService, price: number, size: number): void {
  const notional = Money.of(new Decimal(price).times(size), 'USDC');
  const result = service.reserveForOrder(ACCOUNT_ID, notional);
  if (!result.ok) throw new Error(`Failed to reserve USDC in test setup: ${result.error.message}`);
}

/** Извлекает значение из Result в тестовом setup, бросает при Err. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error('Expected Ok result in test setup');
  return result.value;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PortfolioService — lot-based Position (Этап 3)', () => {
  let store: InMemoryPortfolioStore;
  let service: PortfolioService;

  beforeEach(() => {
    store = new InMemoryPortfolioStore();
    store.save(makePortfolio(), 0);
    service = new PortfolioService(store, makeLogger());
  });

  describe('BUY открывает и накапливает позицию', () => {
    it('первый BUY открывает Position с одним лотом', () => {
      reserveUSDC(service, 0.6, 100);
      const result = service.applyFill(makeFill({ id: 'f1', price: 0.6, size: 100, side: 'BUY', timestampMs: 1000 }));
      expect(result.ok).toBe(true);

      const portfolio = store.get(ACCOUNT_ID)!;
      const position = portfolio.getPosition(INSTRUMENT_ID);
      expect(position).toBeDefined();
      expect(position).toBeInstanceOf(Position);
      expect(position!.quantity.value().toNumber()).toBeCloseTo(100, 8);
      expect(position!.averageEntryPrice.value().toNumber()).toBeCloseTo(0.6, 8);
    });

    it('второй BUY по другой цене добавляет лот — averageEntryPrice = weighted average', () => {
      reserveUSDC(service, 0.6, 100);
      service.applyFill(makeFill({ id: 'f1', price: 0.6, size: 100, side: 'BUY', timestampMs: 1000 }));
      reserveUSDC(service, 0.7, 100);
      service.applyFill(makeFill({ id: 'f2', price: 0.7, size: 100, side: 'BUY', timestampMs: 2000 }));

      const position = store.get(ACCOUNT_ID)!.getPosition(INSTRUMENT_ID)!;
      expect(position.quantity.value().toNumber()).toBeCloseTo(200, 8);
      // (100*0.6 + 100*0.7) / 200 = 0.65 — совпадает с blended-pool моделью (нет closes ещё)
      expect(position.averageEntryPrice.value().toNumber()).toBeCloseTo(0.65, 8);
    });

    it('комиссия уменьшает netFillQty — quantity меньше fill.size, entryPrice не меняется', () => {
      // fee = 1.0 USDC, price = 0.5 → feeInTokens = 1.0 / 0.5 = 2 → net = 100 - 2 = 98
      reserveUSDC(service, 0.5, 100);
      const result = service.applyFill(makeFill({ id: 'f1', price: 0.5, size: 100, side: 'BUY', timestampMs: 1000, feeUSDC: 1.0 }));
      expect(result.ok).toBe(true);

      const position = store.get(ACCOUNT_ID)!.getPosition(INSTRUMENT_ID)!;
      expect(position.quantity.value().toNumber()).toBeCloseTo(98, 8);
      expect(position.averageEntryPrice.value().toNumber()).toBeCloseTo(0.5, 8);
    });
  });

  describe('SELL закрывает позицию по FIFO', () => {
    it('SELL полностью закрывает single-lot позицию — позиция удаляется', () => {
      reserveUSDC(service, 0.6, 100);
      service.applyFill(makeFill({ id: 'f1', price: 0.6, size: 100, side: 'BUY', timestampMs: 1000 }));
      reserveTokens(service, 100);
      const result = service.applyFill(makeFill({ id: 'f2', price: 0.75, size: 100, side: 'SELL', timestampMs: 2000 }));
      expect(result.ok).toBe(true);

      const portfolio = store.get(ACCOUNT_ID)!;
      expect(portfolio.getPosition(INSTRUMENT_ID)).toBeUndefined();
    });

    it('SELL partial close single-lot — quantity и averageEntryPrice ОБА точно совпадают с blended-pool', () => {
      reserveUSDC(service, 0.6, 100);
      service.applyFill(makeFill({ id: 'f1', price: 0.6, size: 100, side: 'BUY', timestampMs: 1000 }));
      reserveTokens(service, 40);
      service.applyFill(makeFill({ id: 'f2', price: 0.75, size: 40, side: 'SELL', timestampMs: 2000 }));

      const position = store.get(ACCOUNT_ID)!.getPosition(INSTRUMENT_ID)!;
      expect(position.quantity.value().toNumber()).toBeCloseTo(60, 8);
      // Единственный лот — FIFO и blended-pool совпадают точно
      expect(position.averageEntryPrice.value().toNumber()).toBeCloseTo(0.6, 8);
    });

    it('SELL без существующей позиции → Err "No position found" (резервация есть, позиции нет — desync)', () => {
      // Искусственно созданное рассинхронизированное состояние (резервация без позиции) —
      // напрямую через Portfolio.create(), минуя reserveTokensForOrder (которая сама
      // проверяет availableTokenQuantity и не позволила бы создать такое состояние).
      store.save(
        makePortfolio(new Map([[INSTRUMENT_ID, Quantity.of(new Decimal(10))]])),
        store.getVersion(ACCOUNT_ID),
      );

      const result = service.applyFill(makeFill({ id: 'f1', price: 0.75, size: 10, side: 'SELL', timestampMs: 1000 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('No position found');
      }
    });

    it('SELL с недостаточным quantity → Err "Sell size exceeds position quantity" (desync: резервация больше позиции)', () => {
      reserveUSDC(service, 0.6, 50);
      service.applyFill(makeFill({ id: 'f1', price: 0.6, size: 50, side: 'BUY', timestampMs: 1000 }));
      // Искусственная резервация на 100 (больше существующей позиции 50) — второй уровень
      // defensive-проверки внутри _applyPositionUpdate, независимый от reserveTokensForOrder.
      const portfolio = store.get(ACCOUNT_ID)!;
      const desynced = unwrap(Portfolio.create({
        id: portfolio.id,
        accountId: portfolio.accountId,
        balance: portfolio.balance,
        positions: portfolio.positions,
        tokenReservations: new Map([[INSTRUMENT_ID, Quantity.of(new Decimal(100))]]),
      }));
      store.save(desynced, store.getVersion(ACCOUNT_ID));

      const result = service.applyFill(makeFill({ id: 'f2', price: 0.75, size: 100, side: 'SELL', timestampMs: 2000 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Sell size exceeds position quantity');
      }
    });
  });

  describe('Multi-lot partial close — известное расхождение averageEntryPrice (FIFO vs blended-pool)', () => {
    it('quantity точно совпадает с blended-pool моделью; averageEntryPrice ожидаемо расходится', () => {
      // Лот1: 50@0.60, Лот2: 50@0.70 → blended avg = 0.65, total qty = 100
      reserveUSDC(service, 0.6, 50);
      service.applyFill(makeFill({ id: 'f1', price: 0.6, size: 50, side: 'BUY', timestampMs: 1000 }));
      reserveUSDC(service, 0.7, 50);
      service.applyFill(makeFill({ id: 'f2', price: 0.7, size: 50, side: 'BUY', timestampMs: 2000 }));

      // SELL 30 — FIFO закрывает 30 из лот1 (старейший)
      reserveTokens(service, 30);
      service.applyFill(makeFill({ id: 'f3', price: 0.8, size: 30, side: 'SELL', timestampMs: 3000 }));

      const position = store.get(ACCOUNT_ID)!.getPosition(INSTRUMENT_ID)!;
      // quantity: 100 - 30 = 70 — ОБЕ модели (FIFO и blended-pool) согласны здесь
      expect(position.quantity.value().toNumber()).toBeCloseTo(70, 8);

      // averageEntryPrice: FIFO оставляет 20@0.60 + 50@0.70 → (20*0.6+50*0.7)/70 ≈ 0.6714
      // Blended-pool модель (старая SimplePosition) держала бы avg=0.65 неизменным —
      // РАСХОЖДЕНИЕ ожидаемо и корректно, не баг (см. docs/architecture/position-accounting.md)
      expect(position.averageEntryPrice.value().toNumber()).toBeCloseTo(0.671428, 5);
      expect(position.averageEntryPrice.value().toNumber()).not.toBeCloseTo(0.65, 2);
    });

    it('realizedPnL корректен для close, полностью укладывающегося в один лот', () => {
      reserveUSDC(service, 0.6, 50);
      service.applyFill(makeFill({ id: 'f1', price: 0.6, size: 50, side: 'BUY', timestampMs: 1000 }));
      reserveUSDC(service, 0.7, 50);
      service.applyFill(makeFill({ id: 'f2', price: 0.7, size: 50, side: 'BUY', timestampMs: 2000 }));

      // SELL 30 @ 0.80 — весь close из лот1 (30 <= 50, старейший): PnL = (0.80-0.60)*30 = 6.0
      const logger = makeLogger();
      const infoCalls: unknown[] = [];
      (logger as unknown as { info: (...args: unknown[]) => void }).info = (...args: unknown[]) => {
        infoCalls.push(args);
      };
      const localService = new PortfolioService(store, logger);
      reserveTokens(localService, 30);
      localService.applyFill(makeFill({ id: 'f3', price: 0.8, size: 30, side: 'SELL', timestampMs: 3000 }));

      const realizedPnLLog = infoCalls.find(
        (call) => Array.isArray(call) && call[0] === 'Position lots closed (FIFO) — realized PnL',
      ) as [string, { realizedPnL: string }] | undefined;
      expect(realizedPnLLog).toBeDefined();
      expect(Number(realizedPnLLog![1].realizedPnL)).toBeCloseTo(6.0, 8);
    });

    it('close-then-reopen: полное закрытие удаляет позицию, следующий BUY открывает новую (без старой lot-истории)', () => {
      reserveUSDC(service, 0.6, 100);
      service.applyFill(makeFill({ id: 'f1', price: 0.6, size: 100, side: 'BUY', timestampMs: 1000 }));
      reserveTokens(service, 100);
      service.applyFill(makeFill({ id: 'f2', price: 0.9, size: 100, side: 'SELL', timestampMs: 2000 }));
      expect(store.get(ACCOUNT_ID)!.getPosition(INSTRUMENT_ID)).toBeUndefined();

      reserveUSDC(service, 0.8, 50);
      service.applyFill(makeFill({ id: 'f3', price: 0.8, size: 50, side: 'BUY', timestampMs: 3000 }));
      const position = store.get(ACCOUNT_ID)!.getPosition(INSTRUMENT_ID)!;
      expect(position.quantity.value().toNumber()).toBeCloseTo(50, 8);
      expect(position.averageEntryPrice.value().toNumber()).toBeCloseTo(0.8, 8);
    });
  });

  describe('Reconstruction — non-lot-based existing IPosition (SimplePosition/тестовые моки)', () => {
    it('BUY поверх существующего SimplePosition не падает — "переоткрывает" lot-учёт', () => {
      // Симулирует состояние, оставленное reverseFill() (не переведён на lot-based, п.3а плана)
      const portfolio = store.get(ACCOUNT_ID)!;
      const withSimplePosition = portfolio.upsertPosition(
        new SimplePosition({
          instrumentId: INSTRUMENT_ID,
          quantity: new Decimal(40),
          averageEntryPrice: new Decimal(0.55),
          side: 'LONG',
        }),
      );
      store.save(withSimplePosition, store.getVersion(ACCOUNT_ID));

      reserveUSDC(service, 0.6, 10);
      const result = service.applyFill(makeFill({ id: 'f1', price: 0.6, size: 10, side: 'BUY', timestampMs: 5000 }));
      expect(result.ok).toBe(true);

      const position = store.get(ACCOUNT_ID)!.getPosition(INSTRUMENT_ID)!;
      expect(position).toBeInstanceOf(Position);
      // Реконструированный лот (40@0.55) + новый лот (10@0.60) = 50 total
      expect(position.quantity.value().toNumber()).toBeCloseTo(50, 8);
    });

    it('SELL поверх существующего SimplePosition не падает — "переоткрывает" lot-учёт', () => {
      const portfolio = store.get(ACCOUNT_ID)!;
      const withSimplePosition = portfolio.upsertPosition(
        new SimplePosition({
          instrumentId: INSTRUMENT_ID,
          quantity: new Decimal(40),
          averageEntryPrice: new Decimal(0.55),
          side: 'LONG',
        }),
      );
      store.save(withSimplePosition, store.getVersion(ACCOUNT_ID));
      reserveTokens(service, 15);

      const result = service.applyFill(makeFill({ id: 'f1', price: 0.7, size: 15, side: 'SELL', timestampMs: 5000 }));
      expect(result.ok).toBe(true);

      const position = store.get(ACCOUNT_ID)!.getPosition(INSTRUMENT_ID)!;
      expect(position).toBeInstanceOf(Position);
      expect(position.quantity.value().toNumber()).toBeCloseTo(25, 8);
    });
  });
});

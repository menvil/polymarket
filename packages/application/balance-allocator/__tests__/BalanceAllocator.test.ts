/**
 * Тесты BalanceAllocator
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import Decimal from 'decimal.js';
import { BalanceAllocator } from '../src/BalanceAllocator.js';
import type { BalanceAllocatorConfig } from '../src/BalanceAllocatorConfig.js';
import type { MarketId } from '@polymarket/ids';
import { Money, MoneyService } from '@polymarket/value-objects';
import { Err } from '@polymarket/result';

// ── Helpers ──────────────────────────────────────────────────────────────────

function usdc(amount: number): Money {
  return Money.of(new Decimal(amount), 'USDC');
}

function makeConfig(overrides?: Partial<BalanceAllocatorConfig>): BalanceAllocatorConfig {
  return {
    tradingBalanceRatio: 0.8,
    minCapitalPerMarket: usdc(50),
    maxConcurrentMarkets: 10,
    ...overrides,
  };
}

function mkt(id: string): MarketId {
  return id as unknown as MarketId;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BalanceAllocator', () => {
  let allocator: BalanceAllocator;

  beforeEach(() => {
    allocator = new BalanceAllocator(makeConfig(), usdc(10000));
  });

  describe('allocateToNewMarkets', () => {
    it('успешно аллоцирует на несколько рынков', () => {
      const results = allocator.allocateToNewMarkets([mkt('m1'), mkt('m2'), mkt('m3')]);

      expect(results.length).toBe(3);
      // tradingBalance = 10000 * 0.8 = 8000; perMarket = 8000 / 3 ≈ 2666.67
      results.forEach((r) => {
        expect(r.allocatedAmount.value().greaterThan(0)).toBe(true);
      });
    });

    it('возвращает [] если нет свободных слотов', () => {
      const config = makeConfig({ maxConcurrentMarkets: 2 });
      allocator = new BalanceAllocator(config, usdc(10000));
      allocator.allocateToNewMarkets([mkt('m1'), mkt('m2')]);

      const results = allocator.allocateToNewMarkets([mkt('m3')]);

      expect(results.length).toBe(0);
    });

    it('возвращает [] если perMarket < minCapitalPerMarket', () => {
      // totalBalance = 100, tradingBalance = 80, 3 рынка → perMarket ≈ 26.67 < 50
      allocator = new BalanceAllocator(makeConfig(), usdc(100));
      const results = allocator.allocateToNewMarkets([mkt('m1'), mkt('m2'), mkt('m3')]);

      // Может аллоцировать только 1 рынок (80 / 50 = 1)
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('пропускает уже аллоцированные рынки', () => {
      allocator.allocateToNewMarkets([mkt('m1')]);
      const results = allocator.allocateToNewMarkets([mkt('m1'), mkt('m2')]);

      // m1 пропускается, m2 получает аллокацию
      expect(results.length).toBe(1);
      const allocatedIds = results.map((r) => String(r.marketId));
      expect(allocatedIds).not.toContain('m1');
      expect(allocatedIds).toContain('m2');
    });

    it('возвращает [] если нет средств', () => {
      allocator = new BalanceAllocator(makeConfig(), usdc(0));
      const results = allocator.allocateToNewMarkets([mkt('m1')]);
      expect(results.length).toBe(0);
    });
  });

  describe('addMarket', () => {
    it('успешно добавляет рынок', () => {
      const result = allocator.addMarket(mkt('m1'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.marketId).toBe(mkt('m1'));
      expect(result.value.allocatedAmount.value().greaterThan(0)).toBe(true);
    });

    it('возвращает Err при полном аллокаторе', () => {
      const config = makeConfig({ maxConcurrentMarkets: 2 });
      allocator = new BalanceAllocator(config, usdc(10000));
      allocator.addMarket(mkt('m1'));
      allocator.addMarket(mkt('m2'));

      const result = allocator.addMarket(mkt('m3'));

      expect(result.ok).toBe(false);
    });

    it('возвращает Err при недостаточном балансе', () => {
      allocator = new BalanceAllocator(makeConfig(), usdc(0));
      const result = allocator.addMarket(mkt('m1'));
      expect(result.ok).toBe(false);
    });
  });

  describe('releaseWithPnL', () => {
    it('увеличивает totalBalance на положительный PnL', () => {
      allocator.addMarket(mkt('m1'));
      const statsBefore = allocator.getStats();
      const beforeBalance = statsBefore.totalBalance.value().toNumber();

      allocator.releaseWithPnL(mkt('m1'), usdc(500));

      const statsAfter = allocator.getStats();
      expect(statsAfter.totalBalance.value().toNumber()).toBe(beforeBalance + 500);
    });

    it('уменьшает totalBalance на убыток', () => {
      allocator.addMarket(mkt('m1'));
      const statsBefore = allocator.getStats();
      const beforeBalance = statsBefore.totalBalance.value().toNumber();

      allocator.releaseWithPnL(mkt('m1'), usdc(-200));

      const statsAfter = allocator.getStats();
      expect(statsAfter.totalBalance.value().toNumber()).toBe(beforeBalance - 200);
    });

    it('освобождает слот', () => {
      const config = makeConfig({ maxConcurrentMarkets: 1 });
      allocator = new BalanceAllocator(config, usdc(10000));
      allocator.addMarket(mkt('m1'));
      expect(allocator.canAddMarket()).toBe(false);

      allocator.releaseWithPnL(mkt('m1'), usdc(0));

      expect(allocator.canAddMarket()).toBe(true);
    });
  });

  describe('getStats', () => {
    it('возвращает корректную статистику без аллокаций', () => {
      const stats = allocator.getStats();

      expect(stats.totalBalance.value().toNumber()).toBe(10000);
      expect(stats.tradingBalance.value().toNumber()).toBeCloseTo(8000);
      expect(stats.allocatedBalance.value().toNumber()).toBe(0);
      expect(stats.activeMarkets).toBe(0);
      expect(stats.availableSlots).toBe(10);
      expect(stats.utilization).toBe(0);
    });

    it('обновляет статистику после аллокации', () => {
      allocator.addMarket(mkt('m1'));
      allocator.addMarket(mkt('m2'));

      const stats = allocator.getStats();

      expect(stats.activeMarkets).toBe(2);
      expect(stats.allocatedBalance.value().greaterThan(0)).toBe(true);
      expect(stats.utilization).toBeGreaterThan(0);
    });
  });

  describe('canAddMarket', () => {
    it('возвращает true при доступных слотах и балансе', () => {
      expect(allocator.canAddMarket()).toBe(true);
    });

    it('возвращает false при нулевом балансе', () => {
      allocator = new BalanceAllocator(makeConfig(), usdc(0));
      expect(allocator.canAddMarket()).toBe(false);
    });

    it('возвращает false при достижении лимита рынков', () => {
      const config = makeConfig({ maxConcurrentMarkets: 1 });
      allocator = new BalanceAllocator(config, usdc(10000));
      allocator.addMarket(mkt('m1'));
      expect(allocator.canAddMarket()).toBe(false);
    });
  });

  describe('updateTotalBalance', () => {
    it('обновляет totalBalance и пересчитывает свободный баланс', () => {
      allocator.updateTotalBalance(usdc(20000));
      const stats = allocator.getStats();
      expect(stats.totalBalance.value().toNumber()).toBe(20000);
      expect(stats.tradingBalance.value().toNumber()).toBeCloseTo(16000);
    });
  });

  describe('addMarket — граничные случаи', () => {
    it('возвращает Err если рынок уже аллоцирован (canAddMarket=true, но allocation пустая)', () => {
      // canAddMarket() не знает про конкретный marketId — вернёт true,
      // но allocateToNewMarkets пропустит уже аллоцированный рынок → [] → строка 164
      allocator.addMarket(mkt('m1'));
      const result = allocator.addMarket(mkt('m1'));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/insufficient free balance/);
    });
  });

  describe('release', () => {
    it('освобождает слот без изменения totalBalance', () => {
      allocator.addMarket(mkt('m1'));
      const balanceBefore = allocator.getStats().totalBalance.value().toNumber();

      allocator.release(mkt('m1'));

      expect(allocator.getStats().activeMarkets).toBe(0);
      expect(allocator.getStats().totalBalance.value().toNumber()).toBe(balanceBefore);
    });

    it('не падает при release несуществующего рынка', () => {
      expect(() => allocator.release(mkt('nonexistent'))).not.toThrow();
    });
  });

  describe('getAllocation', () => {
    it('возвращает аллоцированную сумму для существующего рынка', () => {
      allocator.addMarket(mkt('m1'));
      const allocation = allocator.getAllocation(mkt('m1'));
      expect(allocation).toBeDefined();
      expect(allocation!.value().greaterThan(0)).toBe(true);
    });

    it('возвращает undefined для неаллоцированного рынка', () => {
      expect(allocator.getAllocation(mkt('unknown'))).toBeUndefined();
    });

    it('возвращает undefined после release', () => {
      allocator.addMarket(mkt('m1'));
      allocator.release(mkt('m1'));
      expect(allocator.getAllocation(mkt('m1'))).toBeUndefined();
    });
  });

  describe('releaseWithPnL — currency mismatch', () => {
    it('не применяет PnL и логирует warn при несовпадении валют', () => {
      const warnMock = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn(), trace: jest.fn(), fatal: jest.fn(), child: jest.fn() };
      warnMock.child.mockReturnValue(warnMock);
      const allocatorWithLogger = new BalanceAllocator(makeConfig(), usdc(10000), warnMock as never);

      allocatorWithLogger.addMarket(mkt('m1'));
      const balanceBefore = allocatorWithLogger.getStats().totalBalance.value().toNumber();

      // Мокируем MoneyService.add чтобы вернуть Err при вызове releaseWithPnL
      // (в production это случается при currency mismatch, но Money.of не принимает несуществующие валюты)
      const addSpy = jest.spyOn(MoneyService, 'add').mockReturnValueOnce(
        Err(new Error('currency mismatch') as never),
      );

      allocatorWithLogger.releaseWithPnL(mkt('m1'), usdc(100));

      addSpy.mockRestore();

      // Слот освобождён
      expect(allocatorWithLogger.getStats().activeMarkets).toBe(0);
      // totalBalance не изменился (PnL не применён из-за mocked Err)
      expect(allocatorWithLogger.getStats().totalBalance.value().toNumber()).toBe(balanceBefore);
      // Warn был залогирован
      expect(warnMock.warn).toHaveBeenCalledWith(
        'releaseWithPnL: currency mismatch, PnL not applied',
        expect.objectContaining({ marketId: 'm1' }),
      );
    });
  });
});

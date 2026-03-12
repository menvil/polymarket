/**
 * Тесты BalanceAllocator
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import Decimal from 'decimal.js';
import { BalanceAllocator } from '../src/BalanceAllocator.js';
import type { BalanceAllocatorConfig } from '../src/BalanceAllocatorConfig.js';
import type { MarketId } from '@polymarket/ids';
import { Money, MoneyService, Ratio } from '@polymarket/value-objects';
import { Err } from '@polymarket/result';

// ── Helpers ──────────────────────────────────────────────────────────────────

function usdc(amount: number): Money {
  return Money.of(new Decimal(amount), 'USDC');
}

function ratio(value: number): Ratio {
  return Ratio.of(new Decimal(value));
}

function makeConfig(overrides?: Partial<BalanceAllocatorConfig>): BalanceAllocatorConfig {
  return {
    tradingBalanceRatio: ratio(0.8),
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
      // tradingBalance = 10000 * 0.8 = 8000; perMarket = 8000 / 10 = 800
      results.forEach((r) => {
        expect(r.allocatedAmount.value().toNumber()).toBe(800);
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
      // totalBalance=100, tradingBalance=80, minCapital=50, maxSlots=10
      // maxByCapital = floor(80/50) = 1, newSlots=1
      // perMarket = 80 / max(1,10) = 80/10 = 8 < 50 → []
      allocator = new BalanceAllocator(makeConfig(), usdc(100));
      const results = allocator.allocateToNewMarkets([mkt('m1'), mkt('m2'), mkt('m3')]);

      expect(results.length).toBe(0);
    });

    it('пропускает уже аллоцированные рынки', () => {
      allocator.allocateToNewMarkets([mkt('m1')]);
      const results = allocator.allocateToNewMarkets([mkt('m1'), mkt('m2')]);

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

    it('дедуплицирует marketIds — один рынок не получает двойную аллокацию', () => {
      // Без дедупликации m1 мог бы получить 2 аллокации
      const results = allocator.allocateToNewMarkets([mkt('m1'), mkt('m1'), mkt('m1')]);
      expect(results.length).toBe(1);
      expect(allocator.getStats().activeMarkets).toBe(1);
    });

    it('возвращает [] если все рынки уже аллоцированы', () => {
      allocator.allocateToNewMarkets([mkt('m1'), mkt('m2')]);
      const results = allocator.allocateToNewMarkets([mkt('m1'), mkt('m2')]);
      expect(results).toHaveLength(0);
    });

    it('возвращает [] при ошибке MoneyService.divide', () => {
      const divideSpy = jest.spyOn(MoneyService, 'divide').mockReturnValueOnce(
        Err(new Error('divide error') as never),
      );

      const results = allocator.allocateToNewMarkets([mkt('m1')]);
      expect(results).toHaveLength(0);

      divideSpy.mockRestore();
    });

    it('аллоцирует ровно $800 при balance=10000, ratio=0.8, maxSlots=10', () => {
      // freeBalance=8000, denominator=max(3,10)=10, perMarket=800
      const results = allocator.allocateToNewMarkets([mkt('m1'), mkt('m2'), mkt('m3')]);
      expect(results.length).toBe(3);
      results.forEach((r) => {
        expect(r.allocatedAmount.value().toNumber()).toBe(800);
      });
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

    it('возвращает Err если рынок уже аллоцирован', () => {
      allocator.addMarket(mkt('m1'));
      const result = allocator.addMarket(mkt('m1'));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/already allocated/);
    });
  });

  describe('releaseWithPnL', () => {
    it('увеличивает totalBalance на положительный PnL', () => {
      allocator.addMarket(mkt('m1'));
      const beforeBalance = allocator.getStats().totalBalance.value().toNumber();

      allocator.releaseWithPnL(mkt('m1'), usdc(500));

      expect(allocator.getStats().totalBalance.value().toNumber()).toBe(beforeBalance + 500);
    });

    it('уменьшает totalBalance на убыток', () => {
      allocator.addMarket(mkt('m1'));
      const beforeBalance = allocator.getStats().totalBalance.value().toNumber();

      allocator.releaseWithPnL(mkt('m1'), usdc(-200));

      expect(allocator.getStats().totalBalance.value().toNumber()).toBe(beforeBalance - 200);
    });

    it('освобождает слот', () => {
      const config = makeConfig({ maxConcurrentMarkets: 1 });
      allocator = new BalanceAllocator(config, usdc(10000));
      allocator.addMarket(mkt('m1'));
      expect(allocator.canAddMarket()).toBe(false);

      allocator.releaseWithPnL(mkt('m1'), usdc(0));

      expect(allocator.canAddMarket()).toBe(true);
    });

    it('бросает TradingError при currency mismatch (invariant violation)', () => {
      allocator.addMarket(mkt('m1'));

      // Мокируем MoneyService.add чтобы симулировать currency mismatch
      const addSpy = jest.spyOn(MoneyService, 'add').mockReturnValueOnce(
        Err(new Error('currency mismatch') as never),
      );

      expect(() => allocator.releaseWithPnL(mkt('m1'), usdc(100))).toThrow(
        /currency mismatch/,
      );

      addSpy.mockRestore();
    });

    it('бросает TradingError для несуществующей аллокации', () => {
      expect(() => allocator.releaseWithPnL(mkt('no-such-market'), usdc(0))).toThrow(/no active allocation/);
    });

    it('не изменяет состояние при currency mismatch (атомарность)', () => {
      allocator.addMarket(mkt('m1'));
      const balanceBefore = allocator.getStats().totalBalance.value().toNumber();
      const allocationBefore = allocator.getAllocation(mkt('m1'))!.value().toNumber();

      const addSpy = jest.spyOn(MoneyService, 'add').mockReturnValueOnce(
        Err(new Error('currency mismatch') as never),
      );

      expect(() => allocator.releaseWithPnL(mkt('m1'), usdc(100))).toThrow();

      // Баланс и аллокация не изменились
      expect(allocator.getStats().totalBalance.value().toNumber()).toBe(balanceBefore);
      expect(allocator.getAllocation(mkt('m1'))!.value().toNumber()).toBe(allocationBefore);

      addSpy.mockRestore();
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

  describe('updateTotalBalance', () => {
    it('возвращает Ok и обновляет баланс при корректном значении', () => {
      const result = allocator.updateTotalBalance(usdc(20000));
      expect(result.ok).toBe(true);
      expect(allocator.getStats().totalBalance.value().toNumber()).toBe(20000);
      expect(allocator.getStats().tradingBalance.value().toNumber()).toBeCloseTo(16000);
    });

    it('возвращает Err при over-allocation (новый баланс < аллоцированный)', () => {
      // Аллоцируем 3 рынка при балансе 10000 → каждый ≈ 800 USDC → итого ~2400 аллоцировано
      allocator.allocateToNewMarkets([mkt('m1'), mkt('m2'), mkt('m3')]);

      // Устанавливаем баланс 100 — tradingBalance = 80, allocated ~2400 → over-allocation
      const result = allocator.updateTotalBalance(usdc(100));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/over-allocation/);
      // Баланс не обновился
      expect(allocator.getStats().totalBalance.value().toNumber()).toBe(10000);
    });

    it('разрешает уменьшение баланса если аллокаций нет', () => {
      const result = allocator.updateTotalBalance(usdc(500));
      expect(result.ok).toBe(true);
    });

    it('возвращает Err при ошибке MoneyService.multiply', () => {
      const multiplySpy = jest.spyOn(MoneyService, 'multiply').mockReturnValueOnce(
        Err(new Error('multiply error') as never),
      );

      const result = allocator.updateTotalBalance(usdc(10000));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/Failed to compute trading balance/);

      multiplySpy.mockRestore();
    });

    it('возвращает Err если tradingBalance < allocatedBalance (хотя newBalance > allocatedBalance)', () => {
      // Аллоцируем 3 рынка при балансе 10000 → каждый $800 → allocated = 2400
      allocator.allocateToNewMarkets([mkt('m1'), mkt('m2'), mkt('m3')]);
      const allocated = allocator.getStats().allocatedBalance.value().toNumber(); // 2400

      // newBalance = 3100 > allocated=2400, но tradingBalance = 3100*0.8 = 2480 > 2400 → Ok
      // newBalance = 2800 > allocated=2400, но tradingBalance = 2800*0.8 = 2240 < 2400 → Err
      const result = allocator.updateTotalBalance(usdc(2800));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/over-allocation/);
      // Баланс не изменился
      expect(allocator.getStats().totalBalance.value().toNumber()).toBe(10000);
      // Ранее: allocated = 2400 (3 × 800)
      expect(allocated).toBe(2400);
    });
  });

  describe('restoreAllocations', () => {
    it('восстанавливает аллокации из снимка', () => {
      const snapshot = new Map<MarketId, Money>([
        [mkt('m1'), usdc(800)],
        [mkt('m2'), usdc(600)],
      ]);

      const result = allocator.restoreAllocations(snapshot);

      expect(result.ok).toBe(true);
      expect(allocator.getStats().activeMarkets).toBe(2);
      expect(allocator.getAllocation(mkt('m1'))?.value().toNumber()).toBe(800);
      expect(allocator.getAllocation(mkt('m2'))?.value().toNumber()).toBe(600);
    });

    it('заменяет текущие аллокации (не мержит)', () => {
      // Создаём начальные аллокации
      allocator.allocateToNewMarkets([mkt('old1'), mkt('old2')]);
      expect(allocator.getStats().activeMarkets).toBe(2);

      // Восстанавливаем снимок с другими рынками
      const snapshot = new Map<MarketId, Money>([
        [mkt('new1'), usdc(1000)],
      ]);
      const result = allocator.restoreAllocations(snapshot);

      expect(result.ok).toBe(true);
      expect(allocator.getStats().activeMarkets).toBe(1);
      expect(allocator.getAllocation(mkt('old1'))).toBeUndefined();
      expect(allocator.getAllocation(mkt('new1'))?.value().toNumber()).toBe(1000);
    });

    it('очищает все аллокации при пустом снимке', () => {
      allocator.allocateToNewMarkets([mkt('m1')]);
      const result = allocator.restoreAllocations(new Map());
      expect(result.ok).toBe(true);
      expect(allocator.getStats().activeMarkets).toBe(0);
    });

    it('возвращает Err если снимок превышает maxConcurrentMarkets', () => {
      const config = makeConfig({ maxConcurrentMarkets: 2 });
      allocator = new BalanceAllocator(config, usdc(10000));

      const snapshot = new Map<MarketId, Money>([
        [mkt('m1'), usdc(100)],
        [mkt('m2'), usdc(100)],
        [mkt('m3'), usdc(100)],
      ]);

      const result = allocator.restoreAllocations(snapshot);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/maxConcurrentMarkets/);
      // Состояние не изменилось
      expect(allocator.getStats().activeMarkets).toBe(0);
    });

    it('возвращает Err если сумма снимка превышает торговый баланс', () => {
      // tradingBalance = 10000 * 0.8 = 8000
      const snapshot = new Map<MarketId, Money>([
        [mkt('m1'), usdc(5000)],
        [mkt('m2'), usdc(4000)], // итого 9000 > 8000
      ]);

      const result = allocator.restoreAllocations(snapshot);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/trading balance/);
      // Состояние не изменилось
      expect(allocator.getStats().activeMarkets).toBe(0);
    });

    it('возвращает Err при несовместимых валютах в снимке', () => {
      const addSpy = jest.spyOn(MoneyService, 'add').mockReturnValueOnce(
        Err(new Error('currency mismatch') as never),
      );

      const snapshot = new Map<MarketId, Money>([
        [mkt('m1'), usdc(100)],
        [mkt('m2'), usdc(200)],
      ]);

      const result = allocator.restoreAllocations(snapshot);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/currency mismatch/);
      // Состояние не изменилось
      expect(allocator.getStats().activeMarkets).toBe(0);

      addSpy.mockRestore();
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

    it('возвращает false при ошибке MoneyService.divide', () => {
      const divideSpy = jest.spyOn(MoneyService, 'divide').mockReturnValueOnce(
        Err(new Error('divide error') as never),
      );

      expect(allocator.canAddMarket()).toBe(false);

      divideSpy.mockRestore();
    });
  });

  // ── Приватные defensive-ветки ─────────────────────────────────────────────

  describe('_calcAllocatedBalance (currency mismatch → throw)', () => {
    it('бросает TradingError если аллокации содержат несовместимые валюты', () => {
      // Восстанавливаем аллокации через restoreAllocations (публичный путь),
      // затем эмулируем currency mismatch при суммировании в _calcAllocatedBalance
      const snapshot = new Map<MarketId, Money>([
        [mkt('m1'), usdc(800)],
        [mkt('m2'), usdc(700)],
      ]);
      expect(allocator.restoreAllocations(snapshot).ok).toBe(true);

      const addSpy = jest.spyOn(MoneyService, 'add').mockReturnValueOnce(
        Err(new Error('currency mismatch in allocations') as never),
      );

      // getStats() вызывает _calcAllocatedBalance() → MoneyService.add → throw TradingError
      expect(() => allocator.getStats()).toThrow(/currency mismatch/);

      addSpy.mockRestore();
    });
  });

  describe('_calcFreeBalance (subtract failure → ZERO)', () => {
    it('возвращает [] если MoneyService.subtract вернул ошибку в _calcFreeBalance', () => {
      // _calcFreeBalance вызывает MoneyService.subtract(tradingBalance, allocated)
      // При ошибке возвращает ZERO → perMarket < minCapital → []
      const subtractSpy = jest.spyOn(MoneyService, 'subtract').mockReturnValueOnce(
        Err(new Error('subtract error') as never),
      );

      const results = allocator.allocateToNewMarkets([mkt('m1')]);
      expect(results).toHaveLength(0);

      subtractSpy.mockRestore();
    });
  });

  describe('_countAffordableSlots (slotCost < 0 → 0)', () => {
    it('возвращает [] если minCapitalPerMarket отрицательный (slotCost not positive)', () => {
      // Decimal(0).isPositive() = true в decimal.js (0 имеет знак +1).
      // Ветка !slotCostDec.isPositive() срабатывает только при slotCost < 0.
      // Эмулируем через partial-mock Money с отрицательным value().
      const negativeMinCapital = {
        value: () => new Decimal(-1),
        currency: () => 'USDC',
        toNumber: () => -1,
      } as unknown as Money;

      const config = makeConfig({ minCapitalPerMarket: negativeMinCapital });
      const a = new BalanceAllocator(config, usdc(10000));

      // _countAffordableSlots(8000, -1): slotCostDec=-1, isPositive()=false → 0
      // newSlots = min(1, 0) = 0 → []
      const results = a.allocateToNewMarkets([mkt('m1')]);
      expect(results).toHaveLength(0);
    });
  });
});

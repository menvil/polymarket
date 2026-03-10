import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import { parseAccountId } from '@polymarket/ids';
import { PortfolioReplayService } from '../../src/PortfolioReplayService.js';
import type { ICurrentBalanceProvider } from '../../src/ICurrentBalanceProvider.js';
import type { IPortfolioStore } from '@polymarket/ports';
import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';
import type { Portfolio } from '@polymarket/portfolio';

// ── Вспомогательные фикстуры ─────────────────────────────────────────────────

const accountId = parseAccountId('venue:POLYMARKET:test-user')!;

function makeLogger(): ILogger {
  return {
    child: jest.fn().mockReturnThis() as unknown as ILogger['child'],
    trace:  jest.fn() as unknown as ILogger['trace'],
    debug:  jest.fn() as unknown as ILogger['debug'],
    info:   jest.fn() as unknown as ILogger['info'],
    warn:   jest.fn() as unknown as ILogger['warn'],
    error:  jest.fn() as unknown as ILogger['error'],
  } as unknown as ILogger;
}

function makeBalanceProvider(balance = new Decimal('1000')): ICurrentBalanceProvider {
  return {
    getUsdcBalance: jest.fn<() => Promise<Decimal>>().mockResolvedValue(balance),
  };
}

function makePortfolioStore(existing: Portfolio | undefined = undefined): IPortfolioStore {
  return {
    get:  jest.fn<() => Portfolio | undefined>().mockReturnValue(existing),
    save: jest.fn<() => { ok: true; value: void }>().mockReturnValue({ ok: true, value: undefined }),
  } as unknown as IPortfolioStore;
}

// ── Тесты ────────────────────────────────────────────────────────────────────

describe('PortfolioReplayService', () => {
  let logger: ILogger;

  beforeEach(() => {
    logger = makeLogger();
  });

  describe('replay()', () => {
    it('пропускает инициализацию если Portfolio уже существует', async () => {
      const existingPortfolio = {} as Portfolio;
      const store = makePortfolioStore(existingPortfolio);
      const balanceProvider = makeBalanceProvider();

      const service = new PortfolioReplayService({ balanceProvider, portfolioStore: store, logger });
      await service.replay(accountId);

      expect(balanceProvider.getUsdcBalance).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
    });

    it('создаёт Portfolio с балансом от venue', async () => {
      const store = makePortfolioStore(undefined);
      const balanceProvider = makeBalanceProvider(new Decimal('2500.50'));

      const service = new PortfolioReplayService({ balanceProvider, portfolioStore: store, logger });
      await service.replay(accountId);

      expect(balanceProvider.getUsdcBalance).toHaveBeenCalledWith(accountId);
      expect(store.save).toHaveBeenCalledTimes(1);

      const [savedPortfolio, version] = (store.save as jest.Mock).mock.calls[0] as [Portfolio, number];
      expect(version).toBe(0);
      expect(savedPortfolio.accountId).toBe(accountId);
    });

    it('логирует info при успешной инициализации', async () => {
      const store = makePortfolioStore(undefined);
      const balanceProvider = makeBalanceProvider(new Decimal('500'));

      const service = new PortfolioReplayService({ balanceProvider, portfolioStore: store, logger });
      await service.replay(accountId);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('initialized'),
        expect.objectContaining({ usdcBalance: '500' }),
      );
    });

    it('логирует error и завершает без throw при ошибке balanceProvider', async () => {
      const store = makePortfolioStore(undefined);
      const balanceProvider: ICurrentBalanceProvider = {
        getUsdcBalance: jest.fn<() => Promise<Decimal>>().mockRejectedValue(new Error('API down')),
      };

      const service = new PortfolioReplayService({ balanceProvider, portfolioStore: store, logger });
      await expect(service.replay(accountId)).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch USDC balance'),
        expect.any(Object),
      );
      expect(store.save).not.toHaveBeenCalled();
    });

    it('логирует error при ошибке сохранения Portfolio в store', async () => {
      const store: IPortfolioStore = {
        get:  jest.fn<() => Portfolio | undefined>().mockReturnValue(undefined),
        save: jest.fn<() => { ok: false; error: Error }>().mockReturnValue({
          ok: false,
          error: new Error('Version conflict'),
        }),
      } as unknown as IPortfolioStore;
      const balanceProvider = makeBalanceProvider(new Decimal('100'));

      const service = new PortfolioReplayService({ balanceProvider, portfolioStore: store, logger });
      await expect(service.replay(accountId)).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save portfolio'),
        expect.any(Object),
      );
    });

    it('передаёт accountId в getUsdcBalance', async () => {
      const store = makePortfolioStore(undefined);
      const balanceProvider = makeBalanceProvider(new Decimal('0'));

      const service = new PortfolioReplayService({ balanceProvider, portfolioStore: store, logger });
      await service.replay(accountId);

      const [calledWith] = (balanceProvider.getUsdcBalance as jest.Mock).mock.calls[0] as [AccountId];
      expect(calledWith).toBe(accountId);
    });
  });
});

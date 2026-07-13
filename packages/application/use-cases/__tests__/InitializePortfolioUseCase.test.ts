import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { InitializePortfolioUseCase } from '../src/InitializePortfolioUseCase.js';
import type { InitializePortfolioDeps } from '../src/InitializePortfolioUseCase.js';
import type { ILogger } from '@polymarket/logger';
import type { IPortfolioStore, ICurrentBalanceProvider } from '@polymarket/ports';
import { VersionConflictError } from '@polymarket/ports';
import type { Portfolio } from '@polymarket/portfolio';
import { parseAccountId } from '@polymarket/ids';
import { Ok, Err } from '@polymarket/result';
import Decimal from 'decimal.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn<ILogger['child']>().mockReturnThis() as ILogger['child'],
  };
}

// Реальный parseable AccountId — use case вызывает accountIdToString()
// и создаёт настоящий Balance/Portfolio с этим accountId.
const ACCOUNT_ID = parseAccountId('venue:POLYMARKET:test-account')!;

function makeBalanceProvider(balance = new Decimal('1500')): ICurrentBalanceProvider {
  return {
    getUsdcBalance: jest.fn<ICurrentBalanceProvider['getUsdcBalance']>().mockResolvedValue(balance),
  };
}

function makePortfolioStore(existing?: Portfolio): IPortfolioStore {
  return {
    get: jest.fn<IPortfolioStore['get']>().mockReturnValue(existing),
    save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
    getVersion: jest.fn<IPortfolioStore['getVersion']>().mockReturnValue(0),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('InitializePortfolioUseCase', () => {
  let logger: ILogger;
  let balanceProvider: ICurrentBalanceProvider;
  let portfolioStore: IPortfolioStore;
  let deps: InitializePortfolioDeps;

  beforeEach(() => {
    logger = makeLogger();
    balanceProvider = makeBalanceProvider();
    portfolioStore = makePortfolioStore();
    deps = { balanceProvider, portfolioStore, logger };
  });

  it('happy path: создаёт Portfolio из venue-баланса и сохраняет с версией 0', async () => {
    const useCase = new InitializePortfolioUseCase(deps);

    const result = await useCase.execute(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    expect(balanceProvider.getUsdcBalance).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(portfolioStore.save).toHaveBeenCalledTimes(1);
    const [savedPortfolio, version] = (portfolioStore.save as ReturnType<typeof jest.fn>).mock.calls[0] as [Portfolio, number];
    expect(version).toBe(0); // новый агрегат
    expect(savedPortfolio.accountId).toBe(ACCOUNT_ID);
    expect(savedPortfolio.balance.available().value().toString()).toBe('1500');
    expect(savedPortfolio.balance.reserved().value().toString()).toBe('0');
  });

  it('идемпотентность: существующий Portfolio → Ok, balance provider НЕ вызывается', async () => {
    const existing = { accountId: ACCOUNT_ID } as unknown as Portfolio;
    portfolioStore = makePortfolioStore(existing);
    const useCase = new InitializePortfolioUseCase({ ...deps, portfolioStore });

    const result = await useCase.execute(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    expect(balanceProvider.getUsdcBalance).not.toHaveBeenCalled();
    expect(portfolioStore.save).not.toHaveBeenCalled();
  });

  it('balance provider бросает → Err, ничего не сохраняется', async () => {
    balanceProvider = {
      getUsdcBalance: jest.fn<ICurrentBalanceProvider['getUsdcBalance']>().mockRejectedValue(
        new Error('venue REST unavailable'),
      ),
    };
    const useCase = new InitializePortfolioUseCase({ ...deps, balanceProvider });

    const result = await useCase.execute(ACCOUNT_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/venue REST unavailable/);
    expect(portfolioStore.save).not.toHaveBeenCalled();
  });

  it('конфликт версий при save → Err', async () => {
    portfolioStore = {
      ...makePortfolioStore(),
      save: jest.fn<IPortfolioStore['save']>().mockReturnValue(
        Err(new VersionConflictError('portfolio-test', 0, 1)),
      ),
    };
    const useCase = new InitializePortfolioUseCase({ ...deps, portfolioStore });

    const result = await useCase.execute(ACCOUNT_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/Failed to save Portfolio/);
  });
});

/**
 * PolymarketPortfolioAdapter Balance Tests
 *
 * @remarks
 * Тестирование работы с балансом:
 * - getBalance() - получение доступного USDC баланса
 * - getLockedBalance() - получение замороженного баланса
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PolymarketPortfolioAdapter } from '../../../../../../src/infrastructure/exchange/adapters/portfolio/PolymarketPortfolioAdapter.js';
import type { PolymarketBalanceRestClient } from '../../../../../../src/infrastructure/exchange/clients/PolymarketBalanceRestClient.js';
import type { PolymarketPositionRestClient } from '../../../../../../src/infrastructure/exchange/clients/PolymarketPositionRestClient.js';
import type { PolymarketOrderbookRestClient } from '../../../../../../src/infrastructure/exchange/clients/PolymarketOrderbookRestClient.js';
import { MockLogger } from '../../../../../helpers/MockLogger.js';
import { ExchangeError } from '../../../../../../src/shared/errors/TradingError.js';

describe('PolymarketPortfolioAdapter Balance', () => {
  let adapter: PolymarketPortfolioAdapter;
  let mockBalanceClient: PolymarketBalanceRestClient;
  let mockPositionClient: PolymarketPositionRestClient;
  let mockOrderbookClient: PolymarketOrderbookRestClient;
  let mockLogger: MockLogger;

  beforeEach(() => {
    mockBalanceClient = {
      getBalances: jest.fn().mockResolvedValue([
        {
          asset: 'USDC',
          total: '1000.00',
          available: '850.50',
          locked: '149.50',
        },
      ]),
    } as unknown as PolymarketBalanceRestClient;

    mockPositionClient = {
      getPositions: jest.fn().mockResolvedValue([]),
    } as unknown as PolymarketPositionRestClient;

    mockOrderbookClient = {
      getOrderbook: jest.fn(),
    } as unknown as PolymarketOrderbookRestClient;

    mockLogger = new MockLogger();

    adapter = new PolymarketPortfolioAdapter(
      mockBalanceClient,
      mockPositionClient,
      mockOrderbookClient,
      mockLogger
    );
  });

  describe('getBalance()', () => {
    describe('Success scenarios', () => {
      it('should fetch USDC balance successfully', async () => {
        const balance = await adapter.getBalance();

        expect(balance.amount).toBe(850.50);
        expect(mockBalanceClient.getBalances).toHaveBeenCalledTimes(1);
      });

      it('should return available balance, not total', async () => {
        mockBalanceClient.getBalances = jest.fn().mockResolvedValue([
          {
            asset: 'USDC',
            total: '1000.00',
            available: '700.00',
            locked: '300.00',
          },
        ]);

        const balance = await adapter.getBalance();

        expect(balance.amount).toBe(700.00);
        expect(balance.amount).not.toBe(1000.00);
      });

      it('should handle decimal values correctly', async () => {
        mockBalanceClient.getBalances = jest.fn().mockResolvedValue([
          {
            asset: 'USDC',
            total: '1234.56',
            available: '987.65',
            locked: '246.91',
          },
        ]);

        const balance = await adapter.getBalance();

        expect(balance.amount).toBe(987.65);
      });

      it('should filter by USDC asset', async () => {
        mockBalanceClient.getBalances = jest.fn().mockResolvedValue([
          {
            asset: 'ETH',
            total: '10.0',
            available: '10.0',
            locked: '0',
          },
          {
            asset: 'USDC',
            total: '500.00',
            available: '450.00',
            locked: '50.00',
          },
          {
            asset: 'BTC',
            total: '0.5',
            available: '0.5',
            locked: '0',
          },
        ]);

        const balance = await adapter.getBalance();

        expect(balance.amount).toBe(450.00);
      });
    });

    describe('Edge cases', () => {
      it('should return 0 if USDC balance not found', async () => {
        mockBalanceClient.getBalances = jest.fn().mockResolvedValue([
          { asset: 'ETH', total: '10.0', available: '10.0', locked: '0' },
        ]);

        const balance = await adapter.getBalance();

        expect(balance.amount).toBe(0);
      });

      it('should log warning when USDC not found', async () => {
        mockBalanceClient.getBalances = jest.fn().mockResolvedValue([]);

        await adapter.getBalance();

        const warnLogs = mockLogger.warnCalls.filter((call) =>
          call.message.includes('USDC balance not found')
        );
        expect(warnLogs.length).toBeGreaterThan(0);
      });

      it('should handle empty balances array', async () => {
        mockBalanceClient.getBalances = jest.fn().mockResolvedValue([]);

        const balance = await adapter.getBalance();

        expect(balance.amount).toBe(0);
      });

      it('should handle zero balance', async () => {
        mockBalanceClient.getBalances = jest.fn().mockResolvedValue([
          {
            asset: 'USDC',
            total: '0.00',
            available: '0.00',
            locked: '0.00',
          },
        ]);

        const balance = await adapter.getBalance();

        expect(balance.amount).toBe(0);
      });
    });

    describe('Logging', () => {
      it('should log balance fetch request', async () => {
        await adapter.getBalance();

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('Fetching USDC balance')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });

      it('should log fetched balance', async () => {
        await adapter.getBalance();

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('USDC balance:')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });
    });

    describe('Error handling', () => {
      it('should throw ExchangeError on API failure', async () => {
        mockBalanceClient.getBalances = jest.fn().mockRejectedValue(new Error('Network error'));

        await expect(adapter.getBalance()).rejects.toThrow(ExchangeError);
        await expect(adapter.getBalance()).rejects.toThrow('Failed to fetch balance: Network error');
      });

      it('should log error details', async () => {
        mockBalanceClient.getBalances = jest.fn().mockRejectedValue(new Error('API error'));

        try {
          await adapter.getBalance();
        } catch (error) {
          // Expected
        }

        expect(mockLogger.errorCalls.length).toBeGreaterThan(0);
        expect(mockLogger.errorCalls[0].message).toContain('Failed to fetch balance');
      });

      it('should handle non-Error exceptions', async () => {
        mockBalanceClient.getBalances = jest.fn().mockRejectedValue('String error');

        await expect(adapter.getBalance()).rejects.toThrow(ExchangeError);
      });
    });
  });

  describe('getLockedBalance()', () => {
    describe('Success scenarios', () => {
      it('should fetch locked USDC balance successfully', async () => {
        mockBalanceClient.getBalances = jest.fn().mockResolvedValue([
          {
            asset: 'USDC',
            total: '1000.00',
            available: '850.50',
            locked: '149.50',
          },
        ]);

        const locked = await adapter.getLockedBalance();

        expect(locked.amount).toBe(149.50);
      });

      it('should return locked balance, not available', async () => {
        mockBalanceClient.getBalances = jest.fn().mockResolvedValue([
          {
            asset: 'USDC',
            total: '1000.00',
            available: '700.00',
            locked: '300.00',
          },
        ]);

        const locked = await adapter.getLockedBalance();

        expect(locked.amount).toBe(300.00);
        expect(locked.amount).not.toBe(700.00);
      });

      it('should handle zero locked balance', async () => {
        mockBalanceClient.getBalances = jest.fn().mockResolvedValue([
          {
            asset: 'USDC',
            total: '1000.00',
            available: '1000.00',
            locked: '0.00',
          },
        ]);

        const locked = await adapter.getLockedBalance();

        expect(locked.amount).toBe(0);
      });
    });

    describe('Edge cases', () => {
      it('should return 0 if USDC balance not found', async () => {
        mockBalanceClient.getBalances = jest.fn().mockResolvedValue([]);

        const locked = await adapter.getLockedBalance();

        expect(locked.amount).toBe(0);
      });
    });

    describe('Error handling', () => {
      it('should throw ExchangeError on API failure', async () => {
        mockBalanceClient.getBalances = jest.fn().mockRejectedValue(new Error('Network error'));

        await expect(adapter.getLockedBalance()).rejects.toThrow(ExchangeError);
      });
    });
  });

  describe('Balance consistency', () => {
    it('should have total = available + locked', async () => {
      mockBalanceClient.getBalances = jest.fn().mockResolvedValue([
        {
          asset: 'USDC',
          total: '1000.00',
          available: '700.00',
          locked: '300.00',
        },
      ]);

      const available = await adapter.getBalance();
      const locked = await adapter.getLockedBalance();

      expect(available.amount + locked.amount).toBe(1000);
    });
  });
});

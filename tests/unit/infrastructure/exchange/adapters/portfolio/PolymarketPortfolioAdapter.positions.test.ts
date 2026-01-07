/**
 * PolymarketPortfolioAdapter Positions Tests
 *
 * @remarks
 * Тестирование работы с позициями:
 * - getPosition(tokenId) - получение конкретной позиции
 * - getAllPositions() - получение всех ненулевых позиций
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PolymarketPortfolioAdapter } from '../../../../../../src/infrastructure/exchange/adapters/portfolio/PolymarketPortfolioAdapter.js';
import type { PolymarketBalanceRestClient } from '../../../../../../src/infrastructure/exchange/clients/PolymarketBalanceRestClient.js';
import type { PolymarketPositionRestClient } from '../../../../../../src/infrastructure/exchange/clients/PolymarketPositionRestClient.js';
import type { PolymarketOrderbookRestClient } from '../../../../../../src/infrastructure/exchange/clients/PolymarketOrderbookRestClient.js';
import { MockLogger } from '../../../../../helpers/MockLogger.js';
import { ExchangeError } from '../../../../../../src/shared/errors/TradingError.js';

describe('PolymarketPortfolioAdapter Positions', () => {
  let adapter: PolymarketPortfolioAdapter;
  let mockBalanceClient: PolymarketBalanceRestClient;
  let mockPositionClient: PolymarketPositionRestClient;
  let mockOrderbookClient: PolymarketOrderbookRestClient;
  let mockLogger: MockLogger;

  beforeEach(() => {
    mockBalanceClient = {
      getBalances: jest.fn(),
    } as unknown as PolymarketBalanceRestClient;

    mockPositionClient = {
      getPositions: jest.fn().mockResolvedValue([
        {
          tokenId: '0xtoken123',
          size: '50.5',
        },
        {
          tokenId: '0xtoken456',
          size: '100.0',
        },
      ]),
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

  describe('getPosition()', () => {
    describe('Success scenarios', () => {
      it('should fetch position for specific tokenId', async () => {
        const position = await adapter.getPosition('0xtoken123');

        expect(position.value).toBe(50.5);
        expect(mockPositionClient.getPositions).toHaveBeenCalledTimes(1);
      });

      it('should handle different tokenIds independently', async () => {
        const position1 = await adapter.getPosition('0xtoken123');
        const position2 = await adapter.getPosition('0xtoken456');

        expect(position1.value).toBe(50.5);
        expect(position2.value).toBe(100.0);
        expect(mockPositionClient.getPositions).toHaveBeenCalledTimes(2);
      });

      it('should handle decimal values correctly', async () => {
        mockPositionClient.getPositions = jest.fn().mockResolvedValue([
          {
            tokenId: '0xtoken123',
            size: '123.456',
          },
        ]);

        const position = await adapter.getPosition('0xtoken123');

        expect(position.value).toBe(123.456);
      });

      it('should handle integer values', async () => {
        mockPositionClient.getPositions = jest.fn().mockResolvedValue([
          {
            tokenId: '0xtoken123',
            size: '100',
          },
        ]);

        const position = await adapter.getPosition('0xtoken123');

        expect(position.value).toBe(100);
      });
    });

    describe('Edge cases', () => {
      it('should return 0 if tokenId not found', async () => {
        const position = await adapter.getPosition('0xnonexistent');

        expect(position.value).toBe(0);
      });

      it('should log debug message when position not found', async () => {
        await adapter.getPosition('0xnonexistent');

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('No position found for token')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });

      it('should return 0 if positions array is empty', async () => {
        mockPositionClient.getPositions = jest.fn().mockResolvedValue([]);

        const position = await adapter.getPosition('0xtoken123');

        expect(position.value).toBe(0);
      });

      it('should handle zero position', async () => {
        mockPositionClient.getPositions = jest.fn().mockResolvedValue([
          {
            tokenId: '0xtoken123',
            size: '0',
          },
        ]);

        const position = await adapter.getPosition('0xtoken123');

        expect(position.value).toBe(0);
      });

      it('should filter by exact tokenId match', async () => {
        mockPositionClient.getPositions = jest.fn().mockResolvedValue([
          {
            tokenId: '0xtoken123',
            size: '50',
          },
          {
            tokenId: '0xtoken123456',
            size: '100',
          },
        ]);

        const position = await adapter.getPosition('0xtoken123');

        expect(position.value).toBe(50);
      });
    });

    describe('Logging', () => {
      it('should log position fetch request', async () => {
        await adapter.getPosition('0xtoken123456789abcdef');

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('Fetching position for token 0xtoken123456789')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });

      it('should log fetched position', async () => {
        await adapter.getPosition('0xtoken123');

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('Position for token 0xtoken123')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });
    });

    describe('Error handling', () => {
      it('should throw ExchangeError on API failure', async () => {
        mockPositionClient.getPositions = jest.fn().mockRejectedValue(new Error('Network error'));

        await expect(adapter.getPosition('0xtoken123')).rejects.toThrow(ExchangeError);
        await expect(adapter.getPosition('0xtoken123')).rejects.toThrow(
          'Failed to fetch position: Network error'
        );
      });

      it('should log error details', async () => {
        mockPositionClient.getPositions = jest.fn().mockRejectedValue(new Error('API error'));

        try {
          await adapter.getPosition('0xtoken123');
        } catch (error) {
          // Expected
        }

        expect(mockLogger.errorCalls.length).toBeGreaterThan(0);
        expect(mockLogger.errorCalls[0].message).toContain('Failed to fetch position');
      });

      it('should handle invalid position size', async () => {
        mockPositionClient.getPositions = jest.fn().mockResolvedValue([
          {
            tokenId: '0xtoken123',
            size: 'invalid',
          },
        ]);

        await expect(adapter.getPosition('0xtoken123')).rejects.toThrow(ExchangeError);
      });

      it('should handle negative position size', async () => {
        mockPositionClient.getPositions = jest.fn().mockResolvedValue([
          {
            tokenId: '0xtoken123',
            size: '-50',
          },
        ]);

        await expect(adapter.getPosition('0xtoken123')).rejects.toThrow(ExchangeError);
      });

      it('should handle non-Error exceptions', async () => {
        mockPositionClient.getPositions = jest.fn().mockRejectedValue('String error');

        await expect(adapter.getPosition('0xtoken123')).rejects.toThrow(ExchangeError);
      });
    });
  });

  describe('getAllPositions()', () => {
    describe('Success scenarios', () => {
      it('should fetch all non-zero positions', async () => {
        const positions = await adapter.getAllPositions();

        expect(positions).toHaveLength(2);
        expect(positions[0].tokenId).toBe('0xtoken123');
        expect(positions[0].quantity.value).toBe(50.5);
        expect(positions[1].tokenId).toBe('0xtoken456');
        expect(positions[1].quantity.value).toBe(100.0);
      });

      it('should filter out zero positions', async () => {
        mockPositionClient.getPositions = jest.fn().mockResolvedValue([
          {
            tokenId: '0xtoken123',
            size: '50',
          },
          {
            tokenId: '0xtoken456',
            size: '0',
          },
          {
            tokenId: '0xtoken789',
            size: '100',
          },
        ]);

        const positions = await adapter.getAllPositions();

        expect(positions).toHaveLength(2);
        expect(positions[0].tokenId).toBe('0xtoken123');
        expect(positions[1].tokenId).toBe('0xtoken789');
      });

      it('should filter out invalid positions', async () => {
        mockPositionClient.getPositions = jest.fn().mockResolvedValue([
          {
            tokenId: '0xtoken123',
            size: '50',
          },
          {
            tokenId: '0xtoken456',
            size: 'invalid',
          },
          {
            tokenId: '0xtoken789',
            size: '100',
          },
        ]);

        const positions = await adapter.getAllPositions();

        expect(positions).toHaveLength(2);
        expect(positions[0].tokenId).toBe('0xtoken123');
        expect(positions[1].tokenId).toBe('0xtoken789');
      });

      it('should handle single position', async () => {
        mockPositionClient.getPositions = jest.fn().mockResolvedValue([
          {
            tokenId: '0xtoken123',
            size: '50',
          },
        ]);

        const positions = await adapter.getAllPositions();

        expect(positions).toHaveLength(1);
        expect(positions[0].tokenId).toBe('0xtoken123');
      });

      it('should handle many positions', async () => {
        const manyPositions = Array.from({ length: 20 }, (_, i) => ({
          tokenId: `0xtoken${i}`,
          size: `${i + 1}`,
        }));

        mockPositionClient.getPositions = jest.fn().mockResolvedValue(manyPositions);

        const positions = await adapter.getAllPositions();

        expect(positions).toHaveLength(20);
        expect(positions[0].tokenId).toBe('0xtoken0');
        expect(positions[19].tokenId).toBe('0xtoken19');
      });
    });

    describe('Edge cases', () => {
      it('should return empty array if no positions', async () => {
        mockPositionClient.getPositions = jest.fn().mockResolvedValue([]);

        const positions = await adapter.getAllPositions();

        expect(positions).toEqual([]);
      });

      it('should return empty array if all positions are zero', async () => {
        mockPositionClient.getPositions = jest.fn().mockResolvedValue([
          {
            tokenId: '0xtoken123',
            size: '0',
          },
          {
            tokenId: '0xtoken456',
            size: '0',
          },
        ]);

        const positions = await adapter.getAllPositions();

        expect(positions).toEqual([]);
      });

      it('should handle mixed valid and invalid positions', async () => {
        mockPositionClient.getPositions = jest.fn().mockResolvedValue([
          {
            tokenId: '0xtoken123',
            size: '50',
          },
          {
            tokenId: '0xtoken456',
            size: null as unknown as string,
          },
          {
            tokenId: '0xtoken789',
            size: undefined as unknown as string,
          },
        ]);

        const positions = await adapter.getAllPositions();

        expect(positions).toHaveLength(1);
        expect(positions[0].tokenId).toBe('0xtoken123');
      });
    });

    describe('Logging', () => {
      it('should log fetch request', async () => {
        await adapter.getAllPositions();

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('Fetching all positions')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });

      it('should log result count', async () => {
        await adapter.getAllPositions();

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('Found 2 non-zero positions')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });

      it('should log zero count correctly', async () => {
        mockPositionClient.getPositions = jest.fn().mockResolvedValue([]);

        await adapter.getAllPositions();

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('Found 0 non-zero positions')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });
    });

    describe('Error handling', () => {
      it('should throw ExchangeError on API failure', async () => {
        mockPositionClient.getPositions = jest.fn().mockRejectedValue(new Error('Network error'));

        await expect(adapter.getAllPositions()).rejects.toThrow(ExchangeError);
        await expect(adapter.getAllPositions()).rejects.toThrow(
          'Failed to fetch all positions: Network error'
        );
      });

      it('should log error details', async () => {
        mockPositionClient.getPositions = jest.fn().mockRejectedValue(new Error('API error'));

        try {
          await adapter.getAllPositions();
        } catch (error) {
          // Expected
        }

        expect(mockLogger.errorCalls.length).toBeGreaterThan(0);
        expect(mockLogger.errorCalls[0].message).toContain('Failed to fetch all positions');
      });

      it('should handle non-Error exceptions', async () => {
        mockPositionClient.getPositions = jest.fn().mockRejectedValue('String error');

        await expect(adapter.getAllPositions()).rejects.toThrow(ExchangeError);
      });
    });
  });

  describe('Position data mapping', () => {
    it('should convert API size to Domain Quantity', async () => {
      mockPositionClient.getPositions = jest.fn().mockResolvedValue([
        {
          tokenId: '0xtoken123',
          size: '75.25',
        },
      ]);

      const position = await adapter.getPosition('0xtoken123');

      expect(position.value).toBe(75.25);
      expect(typeof position.value).toBe('number');
    });

    it('should preserve tokenId exactly', async () => {
      const testTokenId = '0x1234567890abcdef';

      mockPositionClient.getPositions = jest.fn().mockResolvedValue([
        {
          tokenId: testTokenId,
          size: '50',
        },
      ]);

      const positions = await adapter.getAllPositions();

      expect(positions[0].tokenId).toBe(testTokenId);
    });
  });
});

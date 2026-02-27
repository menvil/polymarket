/**
 * Тесты для FeeOperationError
 */

import { describe, it, expect } from '@jest/globals';
import { FeeOperationError, FeeOperationErrorReason } from '../../../src/fee/index.js';
import { ErrorSource } from '@polymarket/errors';

describe('FeeOperationError', () => {
  describe('constructor', () => {
    it('should create error with operation and reason', () => {
      const error = new FeeOperationError('Test error message', {
        context: {
          operation: 'add',
          reason: FeeOperationErrorReason.ASSET_MISMATCH,
        },
      });

      expect(error.message).toBe('Test error message');
      expect(error.name).toBe('FeeOperationError');
      expect(error.context.operation).toBe('add');
      expect(error.context.reason).toBe(FeeOperationErrorReason.ASSET_MISMATCH);
    });

    it('should preserve source in context', () => {
      const error = new FeeOperationError('Test error', {
        context: {
          operation: 'add',
          reason: FeeOperationErrorReason.ASSET_MISMATCH,
        },
      });

      expect(error.context.source).toBe(ErrorSource.RULE_VALIDATION);
    });

    it('should preserve kind in context', () => {
      const error = new FeeOperationError('Test error', {
        context: {
          operation: 'add',
          reason: FeeOperationErrorReason.ASSET_MISMATCH,
        },
      });

      expect(error.context.kind).toBe('FeeOperationError');
    });

    it('should preserve additional context fields', () => {
      const error = new FeeOperationError('Test error', {
        context: {
          operation: 'add',
          reason: FeeOperationErrorReason.ASSET_MISMATCH,
          asset1: { type: 'CURRENCY', currency: 'USDC' },
          asset2: { type: 'CURRENCY', currency: 'USDT' },
        },
      });

      expect(error.context.asset1).toEqual({ type: 'CURRENCY', currency: 'USDC' });
      expect(error.context.asset2).toEqual({ type: 'CURRENCY', currency: 'USDT' });
    });

    it('should be instance of Error and have correct name', () => {
      const error = new FeeOperationError('Test error', {
        context: {
          operation: 'add',
          reason: FeeOperationErrorReason.ASSET_MISMATCH,
        },
      });

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('FeeOperationError');
    });

    it('should have all required context fields', () => {
      const error = new FeeOperationError('Asset mismatch', {
        context: {
          operation: 'add',
          reason: FeeOperationErrorReason.ASSET_MISMATCH,
          customField: 'custom value',
        },
      });

      // Required fields
      expect(error.context.operation).toBeDefined();
      expect(error.context.reason).toBeDefined();
      expect(error.context.source).toBeDefined();
      expect(error.context.kind).toBeDefined();

      // Custom field preserved
      expect(error.context.customField).toBe('custom value');
    });
  });
});

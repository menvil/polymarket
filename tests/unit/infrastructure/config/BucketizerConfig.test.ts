/**
 * Bucketizer Configuration Tests
 *
 * @remarks
 * Tests для bucketizer configuration defaults и types.
 * EnvConfig - это singleton, поэтому мы тестируем текущие значения.
 */

import { EnvConfig } from '../../../../src/infrastructure/config/EnvConfig.js';

describe('Bucketizer Configuration', () => {
  describe('Default values', () => {
    it('should have BUCKET_HORIZONS_SEC as array of numbers', () => {
      expect(Array.isArray(EnvConfig.BUCKET_HORIZONS_SEC)).toBe(true);
      expect(EnvConfig.BUCKET_HORIZONS_SEC.length).toBeGreaterThan(0);
      expect(EnvConfig.BUCKET_HORIZONS_SEC.every(h => typeof h === 'number' && h > 0)).toBe(true);
    });

    it('should have BUCKET_TYPES as array of strings', () => {
      expect(Array.isArray(EnvConfig.BUCKET_TYPES)).toBe(true);
      expect(EnvConfig.BUCKET_TYPES.length).toBeGreaterThan(0);
      expect(EnvConfig.BUCKET_TYPES.every(t => typeof t === 'string')).toBe(true);
    });

    it('should have valid REPLAY_MODE', () => {
      expect(['MAX', 'SCALED'].includes(EnvConfig.REPLAY_MODE)).toBe(true);
    });

    it('should have BUCKET_MAX_LEVELS as positive number', () => {
      expect(typeof EnvConfig.BUCKET_MAX_LEVELS).toBe('number');
      expect(EnvConfig.BUCKET_MAX_LEVELS).toBeGreaterThan(0);
    });

    it('should have BUCKET_VOLUME_STEP as positive number', () => {
      expect(typeof EnvConfig.BUCKET_VOLUME_STEP).toBe('number');
      expect(EnvConfig.BUCKET_VOLUME_STEP).toBeGreaterThan(0);
    });

    it('should have valid volume range', () => {
      expect(typeof EnvConfig.BUCKET_VOLUME_MIN).toBe('number');
      expect(typeof EnvConfig.BUCKET_VOLUME_MAX).toBe('number');
      expect(EnvConfig.BUCKET_VOLUME_MIN).toBeGreaterThanOrEqual(0);
      expect(EnvConfig.BUCKET_VOLUME_MAX).toBeGreaterThan(EnvConfig.BUCKET_VOLUME_MIN);
    });

    it('should have BUCKET_REMAINING_QTY as positive number', () => {
      expect(typeof EnvConfig.BUCKET_REMAINING_QTY).toBe('number');
      expect(EnvConfig.BUCKET_REMAINING_QTY).toBeGreaterThan(0);
    });

    it('should have REPLAY_SCALE as number between 0 and 1', () => {
      expect(typeof EnvConfig.REPLAY_SCALE).toBe('number');
      expect(EnvConfig.REPLAY_SCALE).toBeGreaterThan(0);
      expect(EnvConfig.REPLAY_SCALE).toBeLessThanOrEqual(1);
    });

    it('should have REPLAY_MAX_CATCHUP_DELAY_MS as positive number', () => {
      expect(typeof EnvConfig.REPLAY_MAX_CATCHUP_DELAY_MS).toBe('number');
      expect(EnvConfig.REPLAY_MAX_CATCHUP_DELAY_MS).toBeGreaterThan(0);
    });
  });

  describe('Directory paths', () => {
    it('should have BUCKET_INPUT_DIR as string', () => {
      expect(typeof EnvConfig.BUCKET_INPUT_DIR).toBe('string');
      expect(EnvConfig.BUCKET_INPUT_DIR.length).toBeGreaterThan(0);
    });

    it('should have BUCKET_OUTPUT_DIR as string', () => {
      expect(typeof EnvConfig.BUCKET_OUTPUT_DIR).toBe('string');
      expect(EnvConfig.BUCKET_OUTPUT_DIR.length).toBeGreaterThan(0);
    });
  });

  describe('Optional date filters', () => {
    it('should have BUCKET_FROM_DAY as string or undefined', () => {
      const type = typeof EnvConfig.BUCKET_FROM_DAY;
      expect(['string', 'undefined'].includes(type)).toBe(true);
    });

    it('should have BUCKET_TO_DAY as string or undefined', () => {
      const type = typeof EnvConfig.BUCKET_TO_DAY;
      expect(['string', 'undefined'].includes(type)).toBe(true);
    });

    it('should have valid date format if provided', () => {
      if (EnvConfig.BUCKET_FROM_DAY) {
        expect(EnvConfig.BUCKET_FROM_DAY).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }

      if (EnvConfig.BUCKET_TO_DAY) {
        expect(EnvConfig.BUCKET_TO_DAY).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  });

  describe('Configuration consistency', () => {
    it('should have all required bucket configuration fields', () => {
      expect(EnvConfig).toHaveProperty('BUCKET_INPUT_DIR');
      expect(EnvConfig).toHaveProperty('BUCKET_OUTPUT_DIR');
      expect(EnvConfig).toHaveProperty('BUCKET_TYPES');
      expect(EnvConfig).toHaveProperty('BUCKET_MAX_LEVELS');
      expect(EnvConfig).toHaveProperty('BUCKET_VOLUME_STEP');
      expect(EnvConfig).toHaveProperty('BUCKET_VOLUME_MIN');
      expect(EnvConfig).toHaveProperty('BUCKET_VOLUME_MAX');
      expect(EnvConfig).toHaveProperty('BUCKET_REMAINING_QTY');
      expect(EnvConfig).toHaveProperty('BUCKET_HORIZONS_SEC');
      expect(EnvConfig).toHaveProperty('REPLAY_MODE');
      expect(EnvConfig).toHaveProperty('REPLAY_SCALE');
      expect(EnvConfig).toHaveProperty('REPLAY_MAX_CATCHUP_DELAY_MS');
    });

    it('should have sorted horizons', () => {
      const horizons = EnvConfig.BUCKET_HORIZONS_SEC;
      const sorted = [...horizons].sort((a, b) => a - b);
      expect(horizons).toEqual(sorted);
    });
  });
});

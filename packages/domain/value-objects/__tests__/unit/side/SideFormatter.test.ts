/**
 * Тесты для SideFormatter
 */

import { describe, it, expect } from '@jest/globals';
import { SideFormatter } from '../../../src/side/index.js';

describe('SideFormatter', () => {
  describe('toDisplay()', () => {
    it('should format BUY as Buy', () => {
      expect(SideFormatter.toDisplay('BUY')).toBe('Buy');
    });

    it('should format SELL as Sell', () => {
      expect(SideFormatter.toDisplay('SELL')).toBe('Sell');
    });
  });

  describe('toUpperCase()', () => {
    it('should return BUY as is', () => {
      expect(SideFormatter.toUpperCase('BUY')).toBe('BUY');
    });

    it('should return SELL as is', () => {
      expect(SideFormatter.toUpperCase('SELL')).toBe('SELL');
    });
  });

  describe('toLowerCase()', () => {
    it('should convert BUY to buy', () => {
      expect(SideFormatter.toLowerCase('BUY')).toBe('buy');
    });

    it('should convert SELL to sell', () => {
      expect(SideFormatter.toLowerCase('SELL')).toBe('sell');
    });
  });

  describe('toEmoji()', () => {
    it('should return green circle for BUY', () => {
      expect(SideFormatter.toEmoji('BUY')).toBe('🟢');
    });

    it('should return red circle for SELL', () => {
      expect(SideFormatter.toEmoji('SELL')).toBe('🔴');
    });
  });

  describe('toColor()', () => {
    it('should return green for BUY', () => {
      expect(SideFormatter.toColor('BUY')).toBe('green');
    });

    it('should return red for SELL', () => {
      expect(SideFormatter.toColor('SELL')).toBe('red');
    });
  });

  describe('toHexColor()', () => {
    it('should return green hex for BUY', () => {
      expect(SideFormatter.toHexColor('BUY')).toBe('#22c55e');
    });

    it('should return red hex for SELL', () => {
      expect(SideFormatter.toHexColor('SELL')).toBe('#ef4444');
    });
  });

  describe('toLogString()', () => {
    it('should format BUY as exact "🟢 BUY"', () => {
      expect(SideFormatter.toLogString('BUY')).toBe('🟢 BUY');
    });

    it('should format SELL as exact "🔴 SELL"', () => {
      expect(SideFormatter.toLogString('SELL')).toBe('🔴 SELL');
    });
  });

  describe('withSize()', () => {
    it('should format BUY with size', () => {
      expect(SideFormatter.withSize('BUY', 100)).toBe('Buy 100');
    });

    it('should format SELL with size', () => {
      expect(SideFormatter.withSize('SELL', 50)).toBe('Sell 50');
    });

    it('should handle decimal sizes', () => {
      expect(SideFormatter.withSize('BUY', 100.5)).toBe('Buy 100.5');
    });

    it('should handle zero size', () => {
      expect(SideFormatter.withSize('SELL', 0)).toBe('Sell 0');
    });
  });
});

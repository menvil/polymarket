import { SpreadFormatter } from '../../../../src/spread/adapters/SpreadFormatter.js';
import { SpreadService } from '../../../../src/spread/facade/SpreadService.js';

describe('SpreadFormatter', () => {
  describe('format()', () => {
    it('should format spread with default options', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const formatted = SpreadFormatter.format(spreadResult.value);

        // Default: show width, 4 decimals
        expect(formatted).toBe('0.4800-0.5200 (0.0400)');
      }
    });

    it('should format spread without width', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const formatted = SpreadFormatter.format(spreadResult.value, { showWidth: false });

        expect(formatted).toBe('0.4800-0.5200');
      }
    });

    it('should format spread with midpoint', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const formatted = SpreadFormatter.format(spreadResult.value, { showMidpoint: true });

        expect(formatted).toBe('0.4800-0.5200 (0.0400, mid: 0.5000)');
      }
    });

    it('should format spread with custom decimals', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const formatted = SpreadFormatter.format(spreadResult.value, { decimals: 2 });

        expect(formatted).toBe('0.48-0.52 (0.04)');
      }
    });

    it('should format spread without width and midpoint', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const formatted = SpreadFormatter.format(spreadResult.value, {
          showWidth: false,
          showMidpoint: false
        });

        expect(formatted).toBe('0.4800-0.5200');
      }
    });

    it('should format zero width spread', () => {
      const spreadResult = SpreadService.fromValues(0.50, 0.50);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const formatted = SpreadFormatter.format(spreadResult.value);

        expect(formatted).toBe('0.5000-0.5000 (0.0000)');
      }
    });
  });

  describe('toBidAskString()', () => {
    it('should format as simple bid-ask string', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const formatted = SpreadFormatter.toBidAskString(spreadResult.value);

        expect(formatted).toBe('0.4800-0.5200');
      }
    });

    it('should format with custom decimals', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const formatted = SpreadFormatter.toBidAskString(spreadResult.value, 2);

        expect(formatted).toBe('0.48-0.52');
      }
    });
  });

  describe('toDetailedString()', () => {
    it('should format with all details', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const formatted = SpreadFormatter.toDetailedString(spreadResult.value);

        expect(formatted).toBe('0.4800-0.5200 (0.0400, mid: 0.5000)');
      }
    });

    it('should format with custom decimals', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const formatted = SpreadFormatter.toDetailedString(spreadResult.value, 2);

        expect(formatted).toBe('0.48-0.52 (0.04, mid: 0.50)');
      }
    });
  });

  describe('toObject()', () => {
    it('should format as object with all fields', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const obj = SpreadFormatter.toObject(spreadResult.value);

        expect(obj.bid).toBe(0.48);
        expect(obj.ask).toBe(0.52);
        expect(obj.width).toBeCloseTo(0.04, 10);
        expect(obj.midpoint).toBe(0.50);
      }
    });

    it('should format zero width spread as object', () => {
      const spreadResult = SpreadService.fromValues(0.50, 0.50);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const obj = SpreadFormatter.toObject(spreadResult.value);

        expect(obj.bid).toBe(0.50);
        expect(obj.ask).toBe(0.50);
        expect(obj.width).toBe(0);
        expect(obj.midpoint).toBe(0.50);
      }
    });
  });
});

import { describe, it, expect } from '@jest/globals';
import { escape, unescape, splitEscaped } from '../src/core/utils/escaping.js';

describe('Escaping utils', () => {
  describe('escape', () => {
    it('should escape colons', () => {
      expect(escape('A:B')).toBe('A\\:B');
    });

    it('should escape backslashes', () => {
      expect(escape('A\\B')).toBe('A\\\\B');
    });

    it('should escape both backslashes and colons', () => {
      // Input: A\:B (backslash + colon)
      // After escape backslash: A\\:B
      // After escape colon: A\\\\:B
      expect(escape('A\\:B')).toBe('A\\\\\\:B');
    });

    it('should not escape normal characters', () => {
      expect(escape('normal')).toBe('normal');
    });
  });

  describe('unescape', () => {
    it('should unescape colons', () => {
      expect(unescape('A\\:B')).toBe('A:B');
    });

    it('should unescape backslashes', () => {
      expect(unescape('A\\\\B')).toBe('A\\B');
    });

    it('should unescape both', () => {
      // Input: A\\\\\\:B (escaped backslash + escaped colon)
      // After unescape: A\:B
      expect(unescape('A\\\\\\:B')).toBe('A\\:B');
    });

    it('should handle normal characters', () => {
      expect(unescape('normal')).toBe('normal');
    });
  });

  describe('splitEscaped', () => {
    it('should split by unescaped colons', () => {
      expect(splitEscaped('A:B:C')).toEqual(['A', 'B', 'C']);
    });

    it('should not split by escaped colons (returns escaped)', () => {
      expect(splitEscaped('A\\:B:C')).toEqual(['A\\:B', 'C']);
      // After unescape:
      expect(splitEscaped('A\\:B:C').map(unescape)).toEqual(['A:B', 'C']);
    });

    it('should handle escaped backslashes (returns escaped)', () => {
      expect(splitEscaped('A\\\\:B')).toEqual(['A\\\\', 'B']);
      // After unescape:
      expect(splitEscaped('A\\\\:B').map(unescape)).toEqual(['A\\', 'B']);
    });

    it('should handle complex escaping (returns escaped)', () => {
      expect(splitEscaped('A\\\\\\:B:C')).toEqual(['A\\\\\\:B', 'C']);
      // After unescape:
      expect(splitEscaped('A\\\\\\:B:C').map(unescape)).toEqual(['A\\:B', 'C']);
    });
  });

  describe('round-trip', () => {
    it('should preserve string with colon', () => {
      const input = 'A:B';
      const escaped = escape(input);
      const parts = splitEscaped(`PREFIX:${escaped}`);
      // Parts are escaped, need to unescape
      expect(parts.map(unescape)).toEqual(['PREFIX', 'A:B']);
    });

    it('should preserve string with backslash and colon', () => {
      const input = 'user\\:123';
      const escaped = escape(input);
      console.log('Input:', input);
      console.log('Escaped:', escaped);
      const parts = splitEscaped(`VENUE:POLYMARKET:${escaped}`);
      console.log('Parts (escaped):', parts);
      console.log('Parts (unescaped):', parts.map(unescape));
      // Need to unescape to get original value
      expect(unescape(parts[2])).toBe(input);
    });
  });
});

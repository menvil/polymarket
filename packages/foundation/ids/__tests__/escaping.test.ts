import { describe, it, expect } from '@jest/globals';
import { escapeId as escapeField, unescapeId as unescapeField, splitEscaped } from '../src/core/utils/escaping.js';

describe('Escaping utils', () => {
  describe('escape', () => {
    it('should escape colons', () => {
      expect(escapeField('A:B')).toBe('A\\:B');
    });

    it('should escape backslashes', () => {
      expect(escapeField('A\\B')).toBe('A\\\\B');
    });

    it('should escape both backslashes and colons', () => {
      // Input: A\:B (backslash + colon)
      // After escape backslash: A\\:B
      // After escape colon: A\\\\:B
      expect(escapeField('A\\:B')).toBe('A\\\\\\:B');
    });

    it('should not escape normal characters', () => {
      expect(escapeField('normal')).toBe('normal');
    });

    it('should handle empty string', () => {
      expect(escapeField('')).toBe('');
    });

    it('should handle string with only colons', () => {
      expect(escapeField(':::')).toBe('\\:\\:\\:');
    });

    it('should handle string with only backslashes', () => {
      expect(escapeField('\\\\\\')).toBe('\\\\\\\\\\\\');
    });
  });

  describe('unescape', () => {
    it('should unescape colons', () => {
      expect(unescapeField('A\\:B')).toBe('A:B');
    });

    it('should unescape backslashes', () => {
      expect(unescapeField('A\\\\B')).toBe('A\\B');
    });

    it('should unescape both', () => {
      // Input: A\\\\\\:B (escaped backslash + escaped colon)
      // After unescape: A\:B
      expect(unescapeField('A\\\\\\:B')).toBe('A\\:B');
    });

    it('should handle normal characters', () => {
      expect(unescapeField('normal')).toBe('normal');
    });

    it('should handle empty string', () => {
      expect(unescapeField('')).toBe('');
    });

    it('should handle backslash at end of string', () => {
      // Backslash at end (incomplete escape sequence)
      expect(unescapeField('A\\')).toBe('A\\');
    });
  });

  describe('splitEscaped', () => {
    it('should split by unescaped colons', () => {
      expect(splitEscaped('A:B:C')).toEqual(['A', 'B', 'C']);
    });

    it('should not split by escaped colons (returns escaped)', () => {
      expect(splitEscaped('A\\:B:C')).toEqual(['A\\:B', 'C']);
      // After unescape:
      expect(splitEscaped('A\\:B:C').map(unescapeField)).toEqual(['A:B', 'C']);
    });

    it('should handle escaped backslashes (returns escaped)', () => {
      expect(splitEscaped('A\\\\:B')).toEqual(['A\\\\', 'B']);
      // After unescape:
      expect(splitEscaped('A\\\\:B').map(unescapeField)).toEqual(['A\\', 'B']);
    });

    it('should handle complex escaping (returns escaped)', () => {
      expect(splitEscaped('A\\\\\\:B:C')).toEqual(['A\\\\\\:B', 'C']);
      // After unescape:
      expect(splitEscaped('A\\\\\\:B:C').map(unescapeField)).toEqual(['A\\:B', 'C']);
    });

    it('should handle empty string', () => {
      expect(splitEscaped('')).toEqual(['']);
    });

    it('should handle trailing colon', () => {
      expect(splitEscaped('A:B:')).toEqual(['A', 'B', '']);
    });

    it('should handle leading colon', () => {
      expect(splitEscaped(':A:B')).toEqual(['', 'A', 'B']);
    });

    it('should handle consecutive colons', () => {
      expect(splitEscaped('A::B')).toEqual(['A', '', 'B']);
      expect(splitEscaped(':::')).toEqual(['', '', '', '']);
    });
  });

  describe('round-trip', () => {
    it('should preserve string with colon', () => {
      const input = 'A:B';
      const escaped = escapeField(input);
      const parts = splitEscaped(`PREFIX:${escaped}`);
      // Parts are escaped, need to unescape
      expect(parts.map(unescapeField)).toEqual(['PREFIX', 'A:B']);
    });

    it('should preserve string with backslash and colon', () => {
      const input = 'user\\:123';
      const escaped = escapeField(input);
      const parts = splitEscaped(`VENUE:POLYMARKET:${escaped}`);
      // Need to unescape to get original value
      expect(unescapeField(parts[2])).toBe(input);
    });
  });
});

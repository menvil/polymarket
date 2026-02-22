import { describe, it, expect } from '@jest/globals';
import { escapeId, unescapeId, splitEscaped } from '../src/core/utils/escaping.js';

describe('Escaping utils', () => {
  describe('escape', () => {
    it('should escape colons', () => {
      expect(escapeId('A:B')).toBe('A\\:B');
    });

    it('should escape backslashes', () => {
      expect(escapeId('A\\B')).toBe('A\\\\B');
    });

    it('should escape both backslashes and colons', () => {
      // Input: A\:B (backslash + colon)
      // After escape backslash: A\\:B
      // After escape colon: A\\\\:B
      expect(escapeId('A\\:B')).toBe('A\\\\\\:B');
    });

    it('should not escape normal characters', () => {
      expect(escapeId('normal')).toBe('normal');
    });

    it('should handle empty string', () => {
      expect(escapeId('')).toBe('');
    });

    it('should handle string with only colons', () => {
      expect(escapeId(':::')).toBe('\\:\\:\\:');
    });

    it('should handle string with only backslashes', () => {
      expect(escapeId('\\\\\\')).toBe('\\\\\\\\\\\\');
    });
  });

  describe('unescape', () => {
    it('should unescape colons', () => {
      expect(unescapeId('A\\:B')).toBe('A:B');
    });

    it('should unescape backslashes', () => {
      expect(unescapeId('A\\\\B')).toBe('A\\B');
    });

    it('should unescape both', () => {
      // Input: A\\\\\\:B (escaped backslash + escaped colon)
      // After unescape: A\:B
      expect(unescapeId('A\\\\\\:B')).toBe('A\\:B');
    });

    it('should handle normal characters', () => {
      expect(unescapeId('normal')).toBe('normal');
    });

    it('should handle empty string', () => {
      expect(unescapeId('')).toBe('');
    });

    it('should handle backslash at end of string', () => {
      // Backslash at end (incomplete escape sequence)
      expect(unescapeId('A\\')).toBe('A\\');
    });
  });

  describe('splitEscaped', () => {
    it('should split by unescaped colons', () => {
      expect(splitEscaped('A:B:C')).toEqual(['A', 'B', 'C']);
    });

    it('should not split by escaped colons (returns escaped)', () => {
      expect(splitEscaped('A\\:B:C')).toEqual(['A\\:B', 'C']);
      // After unescape:
      expect(splitEscaped('A\\:B:C').map(unescapeId)).toEqual(['A:B', 'C']);
    });

    it('should handle escaped backslashes (returns escaped)', () => {
      expect(splitEscaped('A\\\\:B')).toEqual(['A\\\\', 'B']);
      // After unescape:
      expect(splitEscaped('A\\\\:B').map(unescapeId)).toEqual(['A\\', 'B']);
    });

    it('should handle complex escaping (returns escaped)', () => {
      expect(splitEscaped('A\\\\\\:B:C')).toEqual(['A\\\\\\:B', 'C']);
      // After unescape:
      expect(splitEscaped('A\\\\\\:B:C').map(unescapeId)).toEqual(['A\\:B', 'C']);
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
      const escaped = escapeId(input);
      const parts = splitEscaped(`PREFIX:${escaped}`);
      // Parts are escaped, need to unescape
      expect(parts.map(unescapeId)).toEqual(['PREFIX', 'A:B']);
    });

    it('should preserve string with backslash and colon', () => {
      const input = 'user\\:123';
      const escaped = escapeId(input);
      const parts = splitEscaped(`VENUE:POLYMARKET:${escaped}`);
      // Need to unescape to get original value
      expect(unescapeId(parts[2])).toBe(input);
    });
  });
});

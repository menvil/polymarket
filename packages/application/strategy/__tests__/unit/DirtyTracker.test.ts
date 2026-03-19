import { describe, it, expect, beforeEach } from '@jest/globals';
import { DirtyTracker } from '../../src/DirtyTracker.js';
import type { TriggerReason } from '../../src/types/TriggerReason.js';

describe('DirtyTracker', () => {
  let tracker: DirtyTracker;
  const STRATEGY = 'strategy-1';

  beforeEach(() => {
    tracker = new DirtyTracker();
  });

  // ── markDirty / isDirty ──────────────────────────────────

  describe('markDirty / isDirty', () => {
    it('should be clean by default', () => {
      expect(tracker.isDirty(STRATEGY)).toBe(false);
    });

    it('should become dirty after markDirty', () => {
      tracker.markDirty(STRATEGY, 'BOOK');
      expect(tracker.isDirty(STRATEGY)).toBe(true);
    });

    it('should accumulate multiple reasons', () => {
      tracker.markDirty(STRATEGY, 'BOOK');
      tracker.markDirty(STRATEGY, 'TRADE');
      tracker.markDirty(STRATEGY, 'FILL');

      const reasons = tracker.getReasons(STRATEGY);
      expect(reasons.size).toBe(3);
      expect(reasons.has('BOOK')).toBe(true);
      expect(reasons.has('TRADE')).toBe(true);
      expect(reasons.has('FILL')).toBe(true);
    });

    it('should deduplicate same reason', () => {
      tracker.markDirty(STRATEGY, 'BOOK');
      tracker.markDirty(STRATEGY, 'BOOK');
      tracker.markDirty(STRATEGY, 'BOOK');

      const reasons = tracker.getReasons(STRATEGY);
      expect(reasons.size).toBe(1);
      expect(reasons.has('BOOK')).toBe(true);
    });

    it('should track strategies independently', () => {
      tracker.markDirty('s1', 'BOOK');
      tracker.markDirty('s2', 'FILL');

      expect(tracker.isDirty('s1')).toBe(true);
      expect(tracker.isDirty('s2')).toBe(true);
      expect(tracker.getReasons('s1').has('BOOK')).toBe(true);
      expect(tracker.getReasons('s1').has('FILL')).toBe(false);
      expect(tracker.getReasons('s2').has('FILL')).toBe(true);
      expect(tracker.getReasons('s2').has('BOOK')).toBe(false);
    });
  });

  // ── getReasons ───────────────────────────────────────────

  describe('getReasons', () => {
    it('should return empty set for unknown strategy', () => {
      const reasons = tracker.getReasons('unknown');
      expect(reasons.size).toBe(0);
    });

    it('should return a copy (not internal reference)', () => {
      tracker.markDirty(STRATEGY, 'BOOK');
      const reasons = tracker.getReasons(STRATEGY);

      // Modifying returned set should not affect tracker
      (reasons as Set<TriggerReason>).add('FILL');
      expect(tracker.getReasons(STRATEGY).has('FILL')).toBe(false);
    });
  });

  // ── clearDirty ───────────────────────────────────────────

  describe('clearDirty', () => {
    it('should clear all reasons', () => {
      tracker.markDirty(STRATEGY, 'BOOK');
      tracker.markDirty(STRATEGY, 'TRADE');

      tracker.clearDirty(STRATEGY);

      expect(tracker.isDirty(STRATEGY)).toBe(false);
      expect(tracker.getReasons(STRATEGY).size).toBe(0);
    });

    it('should be safe to call on unknown strategy', () => {
      expect(() => tracker.clearDirty('unknown')).not.toThrow();
    });

    it('should allow re-dirty after clear', () => {
      tracker.markDirty(STRATEGY, 'BOOK');
      tracker.clearDirty(STRATEGY);
      tracker.markDirty(STRATEGY, 'FILL');

      expect(tracker.isDirty(STRATEGY)).toBe(true);
      expect(tracker.getReasons(STRATEGY).has('FILL')).toBe(true);
      expect(tracker.getReasons(STRATEGY).has('BOOK')).toBe(false);
    });

    it('should not affect other strategies', () => {
      tracker.markDirty('s1', 'BOOK');
      tracker.markDirty('s2', 'FILL');

      tracker.clearDirty('s1');

      expect(tracker.isDirty('s1')).toBe(false);
      expect(tracker.isDirty('s2')).toBe(true);
    });
  });

  // ── hasPriorityTrigger ───────────────────────────────────

  describe('hasPriorityTrigger', () => {
    const FILL_PRIORITY = new Set<TriggerReason>(['FILL']);

    it('should return false for unknown strategy', () => {
      expect(tracker.hasPriorityTrigger('unknown', FILL_PRIORITY)).toBe(false);
    });

    it('should return false when no priority reason present', () => {
      tracker.markDirty(STRATEGY, 'BOOK');
      tracker.markDirty(STRATEGY, 'TRADE');

      expect(tracker.hasPriorityTrigger(STRATEGY, FILL_PRIORITY)).toBe(false);
    });

    it('should return true when priority reason present', () => {
      tracker.markDirty(STRATEGY, 'BOOK');
      tracker.markDirty(STRATEGY, 'FILL');

      expect(tracker.hasPriorityTrigger(STRATEGY, FILL_PRIORITY)).toBe(true);
    });

    it('should work with multiple priority triggers', () => {
      const priorities = new Set<TriggerReason>(['FILL', 'ORDER_UPDATE']);

      tracker.markDirty(STRATEGY, 'ORDER_UPDATE');
      expect(tracker.hasPriorityTrigger(STRATEGY, priorities)).toBe(true);
    });

    it('should return false after clear', () => {
      tracker.markDirty(STRATEGY, 'FILL');
      tracker.clearDirty(STRATEGY);

      expect(tracker.hasPriorityTrigger(STRATEGY, FILL_PRIORITY)).toBe(false);
    });

    it('should return false with empty priority set', () => {
      tracker.markDirty(STRATEGY, 'FILL');
      expect(tracker.hasPriorityTrigger(STRATEGY, new Set())).toBe(false);
    });
  });

  // ── remove ───────────────────────────────────────────────

  describe('remove', () => {
    it('should completely remove strategy from tracking', () => {
      tracker.markDirty(STRATEGY, 'BOOK');
      tracker.markDirty(STRATEGY, 'FILL');

      tracker.remove(STRATEGY);

      expect(tracker.isDirty(STRATEGY)).toBe(false);
      expect(tracker.getReasons(STRATEGY).size).toBe(0);
      expect(tracker.hasPriorityTrigger(STRATEGY, new Set(['FILL']))).toBe(false);
    });

    it('should be safe to call on unknown strategy', () => {
      expect(() => tracker.remove('unknown')).not.toThrow();
    });

    it('should not affect other strategies', () => {
      tracker.markDirty('s1', 'BOOK');
      tracker.markDirty('s2', 'FILL');

      tracker.remove('s1');

      expect(tracker.isDirty('s2')).toBe(true);
    });

    it('should allow re-registration after remove', () => {
      tracker.markDirty(STRATEGY, 'BOOK');
      tracker.remove(STRATEGY);
      tracker.markDirty(STRATEGY, 'FILL');

      expect(tracker.isDirty(STRATEGY)).toBe(true);
      expect(tracker.getReasons(STRATEGY).has('FILL')).toBe(true);
      expect(tracker.getReasons(STRATEGY).has('BOOK')).toBe(false);
    });
  });
});

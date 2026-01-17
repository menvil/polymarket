/**
 * ConstraintsObservationStore - LRU-based observation store with TTL
 *
 * @remarks
 * Stores constraint violation observations with confidence-based learning.
 * Prevents memory leak using LRU eviction when maxSize exceeded.
 *
 * Features:
 * - LRU eviction: oldest observations removed when size > maxSize
 * - TTL expiration: observations expire after observationTTL ms
 * - Confidence calculation: confidence = min(1.0, count / minObservations)
 * - Periodic cleanup: optional full TTL cleanup every N ms
 *
 * Eviction strategy:
 * 1. On observe(): if size > maxSize → delete oldest (first in Map)
 * 2. On getConfidence(): move to end (LRU: most recently used)
 * 3. Periodic cleanup: remove expired observations (optional)
 *
 * @example
 * ```typescript
 * const store = new ConstraintsObservationStore({
 *   minObservations: 3,
 *   confidenceThreshold: 0.8,
 *   observationTTL: 3600000, // 1 hour
 *   maxObservations: 10000,
 *   cleanupInterval: 600000, // 10 min
 * }, logger);
 *
 * // Observe violation
 * store.observe(tokenId, { type: 'MIN_SIZE', value: 10 });
 * store.observe(tokenId, { type: 'MIN_SIZE', value: 10 });
 * store.observe(tokenId, { type: 'MIN_SIZE', value: 10 });
 *
 * // Check confidence
 * const confidence = store.getConfidence(tokenId, { type: 'MIN_SIZE', value: 10 });
 * // confidence = 1.0 (3 observations / 3 minObservations)
 *
 * // Should learn?
 * if (store.shouldLearn(tokenId, violation)) {
 *   knowledgeBase.learn(tokenId, violation);
 * }
 *
 * // Cleanup on shutdown
 * store.stop();
 * ```
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';

/**
 * Constraint violation types
 */
export type ConstraintViolationType =
  | 'MIN_SIZE'
  | 'MAX_SIZE'
  | 'SIZE_INCREMENT'
  | 'MIN_PRICE'
  | 'MAX_PRICE'
  | 'PRICE_INCREMENT';

/**
 * Constraint violation data
 */
export interface ConstraintViolation {
  /** Violation type */
  type: ConstraintViolationType;
  /** Violation value (e.g., minimum size) */
  value: number;
}

/**
 * Observation record stored in Map
 */
export interface ObservationRecord {
  /** Token ID */
  tokenId: string;
  /** Constraint violation */
  violation: ConstraintViolation;
  /** Observation count */
  count: number;
  /** First seen timestamp (ms) */
  firstSeen: number;
  /** Last seen timestamp (ms) */
  lastSeen: number;
}

/**
 * ConstraintsObservationStore configuration
 */
export interface ConstraintsObservationStoreConfig {
  /** Minimum observations required for learning */
  minObservations: number;
  /** Confidence threshold for learning (0-1) */
  confidenceThreshold: number;
  /** Observation TTL (ms) */
  observationTTL: number;
  /** Maximum observations to store (LRU eviction) */
  maxObservations?: number;
  /** Periodic cleanup interval (ms, optional) */
  cleanupInterval?: number;
}

/**
 * ConstraintsObservationStore - LRU-based observation store
 *
 * @remarks
 * Stores observations with automatic LRU eviction when maxSize exceeded.
 * Prevents memory leak for long-running services.
 *
 * Guarantees:
 * - Zero memory leak: Map size ≤ maxObservations
 * - LRU eviction: oldest observations deleted first
 * - TTL expiration: expired observations ignored
 * - Periodic cleanup: optional full cleanup timer
 */
export class ConstraintsObservationStore {
  private readonly observations = new Map<string, ObservationRecord>();
  private readonly maxSize: number;
  private cleanupTimer?: NodeJS.Timeout;

  /**
   * Create observation store
   *
   * @param config - Store configuration
   * @param logger - Logger instance
   *
   * @remarks
   * If cleanupInterval specified, starts periodic cleanup timer.
   *
   * @example
   * ```typescript
   * const store = new ConstraintsObservationStore({
   *   minObservations: 3,
   *   confidenceThreshold: 0.8,
   *   observationTTL: 3600000,
   *   maxObservations: 10000,
   *   cleanupInterval: 600000,
   * }, logger);
   * ```
   */
  constructor(
    private readonly config: ConstraintsObservationStoreConfig,
    private readonly logger: ILogger
  ) {
    this.maxSize = config.maxObservations ?? 10000;

    if (config.cleanupInterval) {
      this.startPeriodicCleanup();
    }
  }

  /**
   * Record observation with automatic LRU eviction
   *
   * @param tokenId - Token ID
   * @param violation - Constraint violation
   *
   * @remarks
   * Algorithm:
   * 1. If observation exists: update count + lastSeen, move to end (strict LRU)
   * 2. If new observation:
   *    a. Check size >= maxSize → delete oldest (GUARANTEED first in Map)
   *    b. Add new observation to end
   *
   * CRITICAL LRU guarantees:
   * - Map iteration order = insertion order (ES2015+ spec)
   * - Most recent observations at END of Map
   * - Oldest observations at BEGINNING of Map
   * - Size NEVER exceeds maxSize
   * - Eviction is ALWAYS oldest entry (Map.keys().next().value)
   *
   * High-load safety:
   * - Single-threaded JS: no race conditions
   * - Atomic delete+set: move to end is safe
   * - TTL checked in getConfidence() for lazy expiration
   *
   * @example
   * ```typescript
   * store.observe(tokenId, { type: 'MIN_SIZE', value: 10 });
   * ```
   */
  observe(tokenId: string, violation: ConstraintViolation): void {
    const key = this.makeKey(tokenId, violation);
    const now = Date.now();

    // Check if observation already exists
    if (this.observations.has(key)) {
      const existing = this.observations.get(key)!;

      // CRITICAL: Delete BEFORE re-adding to move to end (strict LRU)
      this.observations.delete(key);

      // Update fields
      existing.count++;
      existing.lastSeen = now;

      // Re-add to end
      this.observations.set(key, existing);

      this.logger.trace('[ObservationStore] Updated observation (moved to end)', {
        tokenId,
        violation,
        count: existing.count,
      });

      return;
    }

    // New observation: check size BEFORE adding
    if (this.observations.size >= this.maxSize) {
      // GUARANTEED: First entry is oldest (Map preserves insertion order)
      const firstKey = this.observations.keys().next().value as string;
      this.observations.delete(firstKey);

      this.logger.trace('[ObservationStore] LRU eviction (size limit)', {
        evictedKey: firstKey,
        size: this.observations.size,
      });
    }

    // Add new observation to end
    this.observations.set(key, {
      tokenId,
      violation,
      count: 1,
      firstSeen: now,
      lastSeen: now,
    });

    this.logger.trace('[ObservationStore] New observation', {
      tokenId,
      violation,
      size: this.observations.size,
    });
  }

  /**
   * Get confidence for observation
   *
   * @param tokenId - Token ID
   * @param violation - Constraint violation
   * @returns Confidence [0.0, 1.0] or 0.0 if expired
   *
   * @remarks
   * Confidence = min(1.0, count / minObservations)
   *
   * Returns 0.0 if:
   * - Observation not found
   * - Observation expired (TTL)
   *
   * Side effect: Moves observation to end (LRU: most recently used)
   *
   * TTL handling:
   * - Checks expiration using Date.now() for consistency
   * - Expired observations deleted immediately (aggressive cleanup)
   * - Prevents Map bloat with stale entries
   *
   * @example
   * ```typescript
   * const confidence = store.getConfidence(tokenId, violation);
   * if (confidence >= 0.8) {
   *   // High confidence - safe to learn
   * }
   * ```
   */
  getConfidence(tokenId: string, violation: ConstraintViolation): number {
    const key = this.makeKey(tokenId, violation);
    const record = this.observations.get(key);

    if (!record) return 0.0;

    // Check TTL with explicit timestamp
    const now = Date.now();
    if (now - record.lastSeen > this.config.observationTTL) {
      // AGGRESSIVE cleanup: delete expired entry immediately
      this.observations.delete(key);

      this.logger.trace('[ObservationStore] Deleted expired observation', {
        tokenId,
        violation,
        age: now - record.lastSeen,
      });

      return 0.0;
    }

    // Move to end (LRU: most recently used)
    // CRITICAL: Delete BEFORE re-adding to move to end
    this.observations.delete(key);
    this.observations.set(key, record);

    return Math.min(1.0, record.count / this.config.minObservations);
  }

  /**
   * Check if should learn constraint
   *
   * @param tokenId - Token ID
   * @param violation - Constraint violation
   * @returns true if confidence >= threshold
   *
   * @remarks
   * Convenience method: getConfidence() >= confidenceThreshold
   *
   * @example
   * ```typescript
   * if (store.shouldLearn(tokenId, violation)) {
   *   knowledgeBase.learn(tokenId, violation);
   * }
   * ```
   */
  shouldLearn(tokenId: string, violation: ConstraintViolation): boolean {
    return this.getConfidence(tokenId, violation) >= this.config.confidenceThreshold;
  }

  /**
   * Make cache key from tokenId and violation
   *
   * @param tokenId - Token ID
   * @param violation - Constraint violation
   * @returns Cache key
   *
   * @remarks
   * Format: `${tokenId}:${violation.type}:${violation.value}`
   */
  private makeKey(tokenId: string, violation: ConstraintViolation): string {
    return `${tokenId}:${violation.type}:${violation.value}`;
  }

  /**
   * Full cleanup: remove all expired observations
   *
   * @remarks
   * Called periodically if cleanupInterval is configured.
   * Iterates through all observations and deletes expired.
   *
   * CRITICAL: Prevents Map bloat with stale entries
   * - Without aggressive cleanup, Map can grow to maxSize with expired entries
   * - This causes subtle memory leak: Map is "full" but contains stale data
   * - At high load, this wastes memory and prevents new observations
   *
   * Algorithm:
   * 1. Get current timestamp (Date.now())
   * 2. Iterate all entries in Map
   * 3. Check TTL: now - lastSeen > observationTTL
   * 4. Delete expired entries immediately
   * 5. Log cleanup stats for monitoring
   *
   * Performance:
   * - O(n) iteration over Map
   * - Acceptable for periodic cleanup (not hot path)
   * - Should run at ~10min intervals (configurable)
   */
  private fullCleanup(): void {
    const before = this.observations.size;
    const now = Date.now(); // Explicit timestamp for consistency
    const keysToDelete: string[] = [];

    // Use Array.from to avoid downlevelIteration requirement
    for (const [key, record] of Array.from(this.observations.entries())) {
      // Check TTL: now - lastSeen > observationTTL
      if (now - record.lastSeen > this.config.observationTTL) {
        keysToDelete.push(key);
      }
    }

    // Delete all expired entries
    for (const key of keysToDelete) {
      this.observations.delete(key);
    }

    if (keysToDelete.length > 0) {
      this.logger.debug('[ObservationStore] Periodic cleanup', {
        deleted: keysToDelete.length,
        before,
        after: this.observations.size,
        percentCleared: ((keysToDelete.length / before) * 100).toFixed(1) + '%',
      });
    }
  }

  /**
   * Start periodic cleanup timer
   *
   * @remarks
   * Calls fullCleanup() every cleanupInterval ms.
   * Timer does not keep process alive (unref()).
   */
  private startPeriodicCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.fullCleanup();
    }, this.config.cleanupInterval!);

    // Don't keep process alive
    this.cleanupTimer.unref();

    this.logger.info('[ObservationStore] Periodic cleanup started', {
      interval: this.config.cleanupInterval,
    });
  }

  /**
   * Stop periodic cleanup timer
   *
   * @remarks
   * Call on shutdown to prevent timer leak.
   *
   * @example
   * ```typescript
   * // On application shutdown
   * observationStore.stop();
   * ```
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;

      this.logger.info('[ObservationStore] Periodic cleanup stopped');
    }
  }

  /**
   * Get current store size
   *
   * @returns Number of observations stored
   *
   * @remarks
   * For monitoring and debugging.
   */
  getSize(): number {
    return this.observations.size;
  }

  /**
   * Clear all observations
   *
   * @remarks
   * For testing only. Should not be used in production.
   */
  clear(): void {
    this.observations.clear();
    this.logger.warn('[ObservationStore] Cleared all observations');
  }
}

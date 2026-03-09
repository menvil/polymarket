/**
 * PolymarketMessageFormatter - Formats Polymarket-specific outgoing WebSocket messages
 *
 * @remarks
 * Responsible for formatting OUTGOING subscribe/unsubscribe messages in Polymarket format.
 * This is the OUTGOING half (paired with PolymarketMessageParser for incoming).
 *
 * Polymarket Subscription Format:
 * ```json
 * {
 *   "assets_ids": ["67704255...", "28257334..."],
 *   "type": "market"
 * }
 * ```
 *
 * Key Responsibilities:
 * - Convert SubscriptionParams to Polymarket JSON format
 * - Validate token IDs (must be numeric strings)
 * - Remove duplicate token IDs
 * - Log warnings for suspicious input
 *
 * Validation Rules:
 * - assets_ids is required and must not be empty
 * - Token IDs must be numeric strings (77 digits)
 * - Duplicates are automatically removed
 * - Invalid tokens are logged but not rejected (let exchange validate)
 *
 * @example
 * ```typescript
 * const formatter = new PolymarketMessageFormatter(logger);
 *
 * const message = formatter.formatSubscription('market', {
 *   assets_ids: ['67704255...', '28257334...', '67704255...'], // duplicate
 *   type: 'market',
 * });
 *
 * console.log(message);
 * // {"assets_ids":["67704255...","28257334..."],"type":"market"}
 * // Note: duplicate removed
 * ```
 *
 * @module infrastructure/polymarket/ws/PolymarketMessageFormatter
 */

import type { IMessageFormatter } from '../../../shared/websocket/IMessageFormatter.js';
import type { SubscriptionParams } from '../../../shared/websocket/types.js';
import type { PolymarketSubscriptionParams } from './types.js';
import type { ILogger } from '../../../domain/ports/ILogger.js';

/**
 * Polymarket message formatter implementation
 *
 * @remarks
 * Implements IMessageFormatter for Polymarket CLOB WebSocket API.
 *
 * Features:
 * - Duplicate token removal
 * - Token format validation
 * - Detailed logging for debugging
 *
 * Error Handling:
 * - Throws Error for missing/empty assets_ids
 * - Logs warnings for invalid token formats (but doesn't throw)
 * - Never returns null/undefined (always throws or returns valid string)
 */
export class PolymarketMessageFormatter implements IMessageFormatter {
  private readonly logger: ILogger;

  /**
   * Create a new Polymarket message formatter
   *
   * @param logger - Logger instance
   *
   * @throws {Error} If logger is null
   *
   * @example
   * ```typescript
   * const formatter = new PolymarketMessageFormatter(logger);
   * ```
   */
  constructor(logger: ILogger) {
    if (!logger) {
      throw new Error('logger is required');
    }

    this.logger = logger.child ? logger.child('PolymarketMessageFormatter') : logger;
  }

  /**
   * Format Polymarket subscription message
   *
   * @param channel - Channel name (ignored by Polymarket)
   * @param params - Subscription parameters
   * @returns JSON string ready to send via WebSocket
   * @throws {Error} If assets_ids is missing or empty
   *
   * @remarks
   * Polymarket doesn't use the channel parameter - it only looks at assets_ids and type.
   *
   * Algorithm:
   * 1. Cast params to PolymarketSubscriptionParams
   * 2. Validate assets_ids exists and is non-empty
   * 3. Remove duplicate token IDs
   * 4. Validate token format (numeric strings)
   * 5. Build subscription object
   * 6. Return JSON.stringify()
   *
   * Validation:
   * - assets_ids must exist → throws Error
   * - assets_ids must not be empty → throws Error
   * - Token IDs should be numeric strings → logs warning if not
   *
   * Duplicate Removal:
   * - Uses Set to remove duplicates
   * - Logs warning if duplicates detected
   *
   * @example
   * ```typescript
   * // Valid subscription
   * const msg = formatter.formatSubscription('market', {
   *   assets_ids: ['67704255...', '28257334...'],
   *   type: 'market',
   * });
   * // Returns: '{"assets_ids":["67704255...","28257334..."],"type":"market"}'
   *
   * // Duplicate removal
   * const msg = formatter.formatSubscription('market', {
   *   assets_ids: ['67704255...', '67704255...'],
   *   type: 'market',
   * });
   * // Returns: '{"assets_ids":["67704255..."],"type":"market"}'
   * // Logs: ⚠️  Duplicate tokens detected
   *
   * // Missing assets_ids (throws)
   * const msg = formatter.formatSubscription('market', {});
   * // Throws: Error('assets_ids is required')
   * ```
   */
  formatSubscription(_channel: string, params: SubscriptionParams): string {
    const polyParams = params as Partial<PolymarketSubscriptionParams>;

    // Validate required fields
    if (!polyParams.assets_ids || polyParams.assets_ids.length === 0) {
      this.logger.error('assets_ids is required for Polymarket subscription', { params });
      throw new Error('assets_ids is required and must not be empty');
    }

    // Remove duplicates
    const uniqueTokens = [...new Set(polyParams.assets_ids)];

    if (uniqueTokens.length !== polyParams.assets_ids.length) {
      const duplicateCount = polyParams.assets_ids.length - uniqueTokens.length;
      this.logger.warn('⚠️  Duplicate tokens detected in subscription!', {
        original: polyParams.assets_ids.length,
        unique: uniqueTokens.length,
        duplicates: duplicateCount,
      });
    }

    // Validate token format (should be numeric strings)
    const invalidTokens = uniqueTokens.filter(t => !/^\d+$/.test(t));
    if (invalidTokens.length > 0) {
      this.logger.error('❌ Invalid token format detected!', {
        invalidCount: invalidTokens.length,
        examples: invalidTokens.slice(0, 3),
        hint: 'Tokens must be numeric strings (e.g., "67704255197116168826604911233626301865010283966205730455742704536521111535950")',
      });
    }

    // Build Polymarket subscription format
    const subscription = {
      assets_ids: uniqueTokens,
      type: polyParams.type || 'market',
    };

    const subscriptionJson = JSON.stringify(subscription);

    // Log subscription details
    this.logger.info('📡 Formatting Polymarket subscription', {
      tokenCount: uniqueTokens.length,
      tokens: uniqueTokens.map(t => t.substring(0, 16) + '...'),
      fullTokens: uniqueTokens, // Full tokens for debugging
      type: subscription.type,
      jsonLength: subscriptionJson.length,
      jsonPreview: subscriptionJson.substring(0, 500) + (subscriptionJson.length > 500 ? '...' : ''),
    });

    return subscriptionJson;
  }

  /**
   * Format Polymarket unsubscription message
   *
   * @param channel - Channel name (ignored by Polymarket)
   * @param params - Unsubscription parameters
   * @returns JSON string ready to send via WebSocket
   * @throws {Error} If assets_ids is missing or empty
   *
   * @remarks
   * Polymarket uses the SAME format for subscribe and unsubscribe.
   * The exchange determines the operation based on current subscription state.
   *
   * This method simply delegates to formatSubscription().
   *
   * @example
   * ```typescript
   * const msg = formatter.formatUnsubscription('market', {
   *   assets_ids: ['67704255...'],
   *   type: 'market',
   * });
   * // Returns: '{"assets_ids":["67704255..."],"type":"market"}'
   * ```
   */
  formatUnsubscription(channel: string, params: SubscriptionParams): string {
    // Polymarket uses same format for subscribe and unsubscribe
    this.logger.debug('Formatting Polymarket unsubscription (same as subscription)', { params });
    return this.formatSubscription(channel, params);
  }
}

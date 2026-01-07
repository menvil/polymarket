/**
 * Market entity representing a prediction market
 *
 * @remarks
 * Represents an immutable prediction market with binary outcomes.
 * Each market has a unique condition ID, question, two outcome tokens,
 * and lifecycle status (ACTIVE, CLOSED, or RESOLVED).
 *
 * Outcomes are stored as a tuple of two OutcomeToken objects,
 * where each token has an ID and a human-readable name (e.g., "Up", "Down").
 *
 * Immutability ensures thread-safety and prevents accidental state mutations.
 * Use factory method `create()` to instantiate new markets.
 *
 * @example
 * ```typescript
 * const market = Market.create({
 *   id: '0x123...',
 *   question: 'Bitcoin Up or Down?',
 *   outcomes: [
 *     { tokenId: '0xabc...', name: 'Up' },
 *     { tokenId: '0xdef...', name: 'Down' }
 *   ],
 *   expirationDate: new Date('2024-12-31T23:59:59Z'),
 *   status: 'ACTIVE'
 * });
 *
 * console.log(market.outcomes[0].name); // "Up"
 * console.log(market.outcomes[1].name); // "Down"
 * ```
 */
import { MarketNotFoundError } from '../../shared/errors/TradingError.js';

/**
 * Market status type
 *
 * @remarks
 * - ACTIVE: Market is open and accepting trades
 * - CLOSED: Market is closed, no new trades allowed
 * - RESOLVED: Market outcome has been determined
 */
export type MarketStatus = 'ACTIVE' | 'CLOSED' | 'RESOLVED';

/**
 * Outcome index type (0 or 1 for binary markets)
 */
export type OutcomeIndex = 0 | 1;

/**
 * Outcome token information
 *
 * @remarks
 * Represents a single outcome in a binary market.
 * Contains the token ID and human-readable name.
 */
export interface OutcomeToken {
  /** Token ID for this outcome */
  readonly tokenId: string;
  /** Human-readable outcome name (e.g., "Up", "Down", "Yes", "No") */
  readonly name: string;
}

/**
 * Market creation parameters
 */
export interface MarketProps {
  readonly id: string;
  readonly question: string;
  readonly marketUrl?: string;
  /** Tuple of two outcome tokens [outcome0, outcome1] */
  readonly outcomes: readonly [OutcomeToken, OutcomeToken];
  readonly expirationDate: Date;
  readonly status: MarketStatus;
  /** Index of the resolved outcome (0 or 1), null if not resolved */
  readonly resolvedOutcomeIndex?: OutcomeIndex | null;
}

/**
 * Market entity
 *
 * @remarks
 * Immutable entity representing a prediction market.
 * All properties are readonly to ensure immutability.
 * Use factory method `create()` for instantiation.
 */
export class Market {
  /** Market unique identifier (condition ID) */
  public readonly id: string;

  /** Market question or description */
  public readonly question: string;

  /** Market URL on Polymarket */
  public readonly marketUrl: string | null;

  /**
   * Market outcomes as a tuple of two tokens
   *
   * @remarks
   * - outcomes[0]: First outcome (e.g., "Up", "Yes")
   * - outcomes[1]: Second outcome (e.g., "Down", "No")
   */
  public readonly outcomes: readonly [OutcomeToken, OutcomeToken];

  /** Market expiration date/time */
  public readonly expirationDate: Date;

  /** Current market status */
  public readonly status: MarketStatus;

  /** Index of the resolved outcome (0 or 1), null if not resolved */
  public readonly resolvedOutcomeIndex: OutcomeIndex | null;

  private constructor(props: MarketProps) {
    this.id = props.id;
    this.question = props.question;
    this.marketUrl = props.marketUrl ?? null;
    this.outcomes = props.outcomes;
    this.expirationDate = props.expirationDate;
    this.status = props.status;
    this.resolvedOutcomeIndex = props.resolvedOutcomeIndex ?? null;
  }

  /**
   * Factory method to create a Market instance
   *
   * @param props - Market properties
   * @returns New Market instance
   * @throws {MarketNotFoundError} If required properties are missing or invalid
   *
   * @example
   * ```typescript
   * const market = Market.create({
   *   id: '0x1234567890abcdef',
   *   question: 'Bitcoin Up or Down?',
   *   outcomes: [
   *     { tokenId: '0xabc...', name: 'Up' },
   *     { tokenId: '0xdef...', name: 'Down' }
   *   ],
   *   expirationDate: new Date('2024-12-31'),
   *   status: 'ACTIVE'
   * });
   * ```
   */
  public static create(props: MarketProps): Market {
    // Validate required fields
    if (!props.id || props.id.trim() === '') {
      throw new MarketNotFoundError('invalid-id');
    }

    if (!props.question || props.question.trim() === '') {
      throw new MarketNotFoundError(props.id);
    }

    // Validate outcomes
    if (!props.outcomes || props.outcomes.length !== 2) {
      throw new MarketNotFoundError(props.id);
    }

    if (!props.outcomes[0]?.tokenId || props.outcomes[0].tokenId.trim() === '') {
      throw new MarketNotFoundError(props.id);
    }

    if (!props.outcomes[1]?.tokenId || props.outcomes[1].tokenId.trim() === '') {
      throw new MarketNotFoundError(props.id);
    }

    if (!props.outcomes[0]?.name || props.outcomes[0].name.trim() === '') {
      throw new MarketNotFoundError(props.id);
    }

    if (!props.outcomes[1]?.name || props.outcomes[1].name.trim() === '') {
      throw new MarketNotFoundError(props.id);
    }

    if (!props.expirationDate || !(props.expirationDate instanceof Date) || isNaN(props.expirationDate.getTime())) {
      throw new MarketNotFoundError(props.id);
    }

    // Validate status
    const validStatuses: MarketStatus[] = ['ACTIVE', 'CLOSED', 'RESOLVED'];
    if (!validStatuses.includes(props.status)) {
      throw new MarketNotFoundError(props.id);
    }

    // If resolved, must have an outcome index
    if (props.status === 'RESOLVED' && props.resolvedOutcomeIndex === undefined) {
      throw new MarketNotFoundError(props.id);
    }

    return new Market(props);
  }

  /**
   * Gets outcome by index
   *
   * @param index - Outcome index (0 or 1)
   * @returns OutcomeToken for the specified index
   *
   * @example
   * ```typescript
   * const firstOutcome = market.getOutcome(0);
   * console.log(firstOutcome.name); // "Up"
   * console.log(firstOutcome.tokenId); // "0xabc..."
   * ```
   */
  public getOutcome(index: OutcomeIndex): OutcomeToken {
    return this.outcomes[index];
  }

  /**
   * Gets outcome index by token ID
   *
   * @param tokenId - Token ID to find
   * @returns Outcome index (0 or 1), or null if not found
   *
   * @example
   * ```typescript
   * const index = market.getOutcomeIndexByTokenId('0xabc...');
   * if (index !== null) {
   *   console.log(market.outcomes[index].name); // "Up"
   * }
   * ```
   */
  public getOutcomeIndexByTokenId(tokenId: string): OutcomeIndex | null {
    if (this.outcomes[0].tokenId === tokenId) return 0;
    if (this.outcomes[1].tokenId === tokenId) return 1;
    return null;
  }

  /**
   * Gets outcome by token ID
   *
   * @param tokenId - Token ID to find
   * @returns OutcomeToken or null if not found
   *
   * @example
   * ```typescript
   * const outcome = market.getOutcomeByTokenId('0xabc...');
   * if (outcome) {
   *   console.log(outcome.name); // "Up"
   * }
   * ```
   */
  public getOutcomeByTokenId(tokenId: string): OutcomeToken | null {
    const index = this.getOutcomeIndexByTokenId(tokenId);
    return index !== null ? this.outcomes[index] : null;
  }

  /**
   * Checks if the market has expired
   *
   * @returns True if current time is past expiration date
   *
   * @example
   * ```typescript
   * if (market.isExpired()) {
   *   console.log('Market has expired');
   * }
   * ```
   */
  public isExpired(): boolean {
    return Date.now() > this.expirationDate.getTime();
  }

  /**
   * Calculates time remaining until expiration
   *
   * @returns Milliseconds until expiration (negative if expired)
   *
   * @example
   * ```typescript
   * const msRemaining = market.timeToExpiry();
   * const hoursRemaining = msRemaining / (1000 * 60 * 60);
   * console.log(`Hours remaining: ${hoursRemaining.toFixed(2)}`);
   * ```
   */
  public timeToExpiry(): number {
    return this.expirationDate.getTime() - Date.now();
  }

  /**
   * Checks if the market is resolved
   *
   * @returns True if market status is RESOLVED
   *
   * @example
   * ```typescript
   * if (market.isResolved()) {
   *   const winningOutcome = market.getResolvedOutcome();
   *   console.log(`Winner: ${winningOutcome?.name}`);
   * }
   * ```
   */
  public isResolved(): boolean {
    return this.status === 'RESOLVED';
  }

  /**
   * Gets the resolved outcome (if market is resolved)
   *
   * @returns OutcomeToken of the winning outcome, or null if not resolved
   *
   * @example
   * ```typescript
   * const winner = market.getResolvedOutcome();
   * if (winner) {
   *   console.log(`Winning outcome: ${winner.name}`);
   * }
   * ```
   */
  public getResolvedOutcome(): OutcomeToken | null {
    if (this.resolvedOutcomeIndex === null) return null;
    return this.outcomes[this.resolvedOutcomeIndex];
  }

  /**
   * Checks if the market is active
   *
   * @returns True if market status is ACTIVE
   *
   * @example
   * ```typescript
   * if (market.isActive() && !market.isExpired()) {
   *   console.log('Market is open for trading');
   * }
   * ```
   */
  public isActive(): boolean {
    return this.status === 'ACTIVE';
  }

  /**
   * Checks if market can accept new trades
   *
   * @returns True if market is active and not expired
   *
   * @example
   * ```typescript
   * if (market.canTrade()) {
   *   // Place order
   * }
   * ```
   */
  public canTrade(): boolean {
    return this.isActive() && !this.isExpired();
  }

  /**
   * Converts market to string representation
   *
   * @returns String representation of the market
   *
   * @example
   * ```typescript
   * console.log(market.toString());
   * // Output: "Market[0x123...]: Bitcoin Up or Down? [Up/Down] (ACTIVE)"
   * ```
   */
  public toString(): string {
    const outcomeNames = `[${this.outcomes[0].name}/${this.outcomes[1].name}]`;
    return `Market[${this.id}]: ${this.question} ${outcomeNames} (${this.status})`;
  }
}

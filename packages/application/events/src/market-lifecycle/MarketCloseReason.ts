/**
 * Причина закрытия рынка.
 *
 * @remarks
 * - `EXPIRED` — рынок истёк (ExpirationRemovalPolicy)
 * - `MANUAL` — ручная остановка оператором
 * - `POLICY` — другая policy (RiskPolicy, MarketQualityPolicy и т.п.)
 */
export type MarketCloseReason = 'EXPIRED' | 'MANUAL' | 'POLICY';

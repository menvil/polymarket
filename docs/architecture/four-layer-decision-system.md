# 4-Layer Decision System

## Overview

The 4-Layer Decision System is an integrated risk management and quote generation architecture that determines trading behavior based on market conditions, edge viability, and position risk.

```
┌─────────────────────────────────────────────────────────────────┐
│                 MainTradingOrchestrator                          │
│                    updateQuotes()                                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │  RiskAssessmentService │
              │     assess() method    │
              └────────────┬───────────┘
                           │
     ┌─────────────────────┼─────────────────────┐
     │                     │                     │
     ▼                     ▼                     ▼
┌──────────┐        ┌──────────────┐      ┌─────────────┐
│ Layer 0  │        │   Layer 1    │      │   Layer 2   │
│  Edge    │───────▶│   Signals    │─────▶│    Risk     │
│  Alive   │        │              │      │             │
└──────────┘        └──────────────┘      └──────────────┘
     │                     │                     │
     │                     │                     │
     └─────────────────────┼─────────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │  RiskAssessment        │
              │  {mode, fragilityScore}│
              └────────────┬───────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │  TwoSidedMarketMaker   │  ← Layer 3
              │  generateQuotes(       │
              │    mode, fragility     │
              │  )                     │
              └────────────────────────┘
```

---

## Layer 0: Edge Alive Evaluator

**File**: `src/domain/services/risk/EdgeAliveEvaluator.ts`

**Purpose**: Determine if profitable market making is possible.

### State Machine

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│    ALIVE ──[badStreak ≥ 1]──▶ WARNING ──[badStreak ≥ N]──▶ DEAD
│      ▲                           │                            │
│      │                           │                            │
│      └──[goodStreak ≥ M]─────────┘                            │
│                                                               │
│    During warmup: DEAD is reversible                          │
│    After warmup: DEAD is IRREVERSIBLE                         │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Metrics Evaluated

| Metric | Description | Threshold |
|--------|-------------|-----------|
| `fragilityScore` | How easily price moves with volume | ≥ 0.10 |
| `relativeRefillRate` | Orderbook depth recovery (percentage growth) | ≥ 0.30 |
| `timeToExpiry` | Minutes until market closes | ≥ 4 min |

**Note**: Uses `refillRates.relative` from OrderbookHealthMonitor (chosen for intuitive interpretation: 0.3 = 30% average depth growth per update).

### Configuration (.env)

```bash
# Edge Alive Configuration
EDGE_ALIVE_MIN_FRAGILITY_SCORE=0.1    # Minimum fragility for alive edge
EDGE_ALIVE_MIN_REFILL_RATE=0.3        # Minimum orderbook refill rate
EDGE_ALIVE_MIN_TIME_TO_EXPIRY_MIN=4   # Minimum minutes to expiry
EDGE_ALIVE_WARMUP_MS=90000            # Warmup period (death reversible)
EDGE_ALIVE_BAD_STREAK_TO_DEAD=4       # Bad evaluations to die
EDGE_ALIVE_GOOD_STREAK_TO_REVIVE=2    # Good evaluations to revive
EDGE_ALIVE_STREAK_DECAY_ALPHA=0.8     # Streak decay factor
```

### Output

```typescript
interface EdgeEvaluation {
  alive: boolean;           // Is edge alive?
  warning: boolean;         // Is edge in warning state?
  irreversible: boolean;    // Is death permanent?
  reason: string;           // Human-readable reason
  fragilityScore: number;   // Current fragility
  refillRate: number;       // Current relative refill rate (0.3 = 30% growth)
  timeToExpiry: number;     // Minutes to expiry
}
```

**Note**: `refillRate` field contains `relativeRefillRate` value for backward compatibility.

---

## Layer 1: Signal Components

### TradeFlowAnalyzer

**File**: `src/domain/services/signals/TradeFlowAnalyzer.ts`

**Purpose**: Analyze trade flow for fragility and market state.

**Metrics**:
- `fragilityScore`: 0-1 (higher = more fragile/toxic)
- `tradeImbalance`: -1 to +1 (buy/sell pressure)
- `marketState`: QUIET | NEUTRAL | TRENDING_UP | TRENDING_DOWN
- `marketPressureScore`: Combined pressure metric

**Configuration (.env)**:
```bash
TRADE_FLOW_BOOK_LEVELS=2              # Orderbook levels for analysis
TRADE_FLOW_BOOK_MIN_THRESHOLD=0.2     # Min imbalance for signal
TRADE_FLOW_MIN_AGGRESSIVE_VOLUME=5    # Min volume for fragility
TRADE_FLOW_FRAGILITY_SCALE=5          # Fragility scaling factor
TRADE_FLOW_DECAY_LAMBDA=0.002         # Exponential decay rate
TRADE_FLOW_TIME_TO_FILL_FAST=200      # Fast fill threshold (ms)
TRADE_FLOW_TIME_TO_FILL_MEDIUM=500    # Medium fill threshold (ms)
TRADE_FLOW_TIME_TO_FILL_SLOW=1000     # Slow fill threshold (ms)
```

### OrderbookHealthMonitor

**File**: `src/domain/services/signals/OrderbookHealthMonitor.ts`

**Purpose**: Monitor orderbook depth and recovery.

**Metrics**:
- `refillRates`: Three complementary metrics measuring liquidity recovery speed:
  - `absolute`: [0, 3] - Absolute volume growth relative to EMA baseline (USDC)
  - `relative`: [0, 1.5] - Percentage depth growth (e.g., 0.5 = 50% growth)
  - `logarithmic`: [0, ∞) - Log-scale change (scale-invariant, naturally bounded)
- `isThinning`: boolean (is depth decreasing?)
- `bookImbalance`: -1 to +1 (bid/ask imbalance)

**Why Three Metrics?**
- **Absolute**: Measures real USDC volume recovery strength
- **Relative**: Intuitive percentage-based metric (most similar to old binary refillRate)
- **Logarithmic**: Robust to market size variations, compresses large changes

**Configuration (.env)**:
```bash
ORDERBOOK_HEALTH_MIN_DEPTH=20          # Min healthy depth
ORDERBOOK_HEALTH_EMA_ALPHA=0.1         # EMA smoothing factor (refillRates)
ORDERBOOK_HEALTH_BASELINE_ALPHA=0.05   # EMA baseline factor (slower)
ORDERBOOK_HEALTH_ABS_MAX_BOUND=3       # Max clip for absoluteRefillRate
ORDERBOOK_HEALTH_REL_MAX_BOUND=1.5     # Max clip for relativeRefillRate
ORDERBOOK_HEALTH_SUMMARY_INTERVAL_MS=10000  # Log interval
```

---

## Layer 2: Risk Assessment

**File**: `src/domain/services/risk/RiskAssessmentService.ts`

**Purpose**: Integrate all signals and determine trading mode.

### Trading Modes

| Mode | Description | Quoting Behavior |
|------|-------------|------------------|
| `FLAT` | No position | Normal two-sided |
| `QUOTE` | Has position, normal risk | Normal two-sided |
| `INVENTORY` | High inventory utilization | Skewed quotes |
| `RECOVERY` | Need to reduce position | One-sided only |
| `PANIC` | Emergency exit needed | Aggressive crossing |
| `DEAD` | Edge is dead | No quotes |

### Mode Determination Logic

```
if (edgeAlive === false && irreversible):
    return DEAD

if (urgency ≥ panicThreshold):      // default: 0.8
    return PANIC

if (hasPosition && timePressure high):
    return RECOVERY

if (inventoryUtilization ≥ inventoryThreshold):  // default: 0.5
    return INVENTORY

if (hasPosition):
    return QUOTE

return FLAT
```

### Configuration (.env)

```bash
RISK_MAX_NET_POSITION=1000        # Max net position (YES - NO)
RISK_MAX_GROSS_POSITION=2000      # Max gross position (YES + NO)
RISK_PANIC_THRESHOLD=0.8          # Urgency threshold for PANIC
RISK_INVENTORY_THRESHOLD=0.5      # Urgency threshold for INVENTORY
RISK_TIME_URGENCY_SECONDS=86400   # Time pressure period (24h)
```

### Output

```typescript
interface RiskAssessment {
  // Mode
  status: 'NORMAL' | 'WARNING' | 'PANIC' | 'DEAD';
  mode: TradingMode;
  urgency: Percentage;

  // Edge (Layer 0)
  edgeAlive: boolean;
  edgeWarning: boolean;
  edgeIrreversible: boolean;
  edgeReason: string;

  // Signals (Layer 1)
  fragilityScore: number;
  marketState: MarketState;
  refillRate: number;           // relativeRefillRate (percentage growth)
  isThinning: boolean;
  tradeImbalance: number;
  bookImbalance: number;

  // Position
  netPosition: number;
  hasPosition: boolean;
  netPositionUtilization: Percentage;
  grossPositionUtilization: Percentage;

  // Time
  secondsToExpiry: number;
  timeToExpiry: string;
}
```

---

## Layer 3: Quote Generation

**File**: `src/domain/strategies/TwoSidedMarketMaker.ts`

**Purpose**: Generate quotes based on mode and market conditions.

### Mode-Aware Quoting

```typescript
generateQuotes(
  session: TradingSession,
  market: Market,
  orderbook: Orderbook,
  mode: TradingMode,        // From RiskAssessment
  fragilityScore: number    // From RiskAssessment
): Quote[]
```

### Quote Behavior by Mode

| Mode | Behavior |
|------|----------|
| `FLAT/QUOTE` | Two-sided quotes around fair value |
| `INVENTORY` | Non-linear skew to reduce inventory |
| `RECOVERY` | One-sided quotes with fragility boost |
| `PANIC` | Aggressive spread crossing |
| `DEAD` | Empty quotes (no trading) |

### Non-Linear Inventory Skew

```
skew = sign(position) × |position/maxPosition|^exponent × baseFactor × timePressure

Where:
- exponent = 2.5 (quadratic+ curve)
- baseFactor = 0.05 (5% base skew)
- timePressure = urgency × 2
- maxSkew = 0.20 (20% cap)
```

### Recovery/Panic Quote Pricing

```
// RECOVERY mode
crossing = baseCrossing + (fragilityScore × 0.02)
price = bestBid - crossing  // for SELL

// PANIC mode
crossing = panicMaxCrossing  // 3%
price = bestBid - crossing   // for SELL
```

---

## Integration in MainTradingOrchestrator

**File**: `src/application/orchestrators/MainTradingOrchestrator.ts`

### Event Recording

```typescript
// Record trades for TradeFlowAnalyzer
handleTradeUpdate(trade) {
  this.riskAssessmentService.recordTrade({
    price: trade.price.value,
    size: trade.quantity.value,
    bestBid, bestAsk, timestamp
  });
}

// Record orderbook for OrderbookHealthMonitor
handleOrderbookUpdate(orderbook) {
  this.riskAssessmentService.recordOrderbook(orderbook);
}
```

### Decision Flow

```typescript
async updateQuotes() {
  // 1. Get assessment from all layers
  const assessment = this.riskAssessmentService.assess(session, market, config);

  // 2. Handle DEAD mode
  if (assessment.mode === 'DEAD') {
    await this.cancelAllOrders();
    this.onEdgeDeath?.(marketId, reason);
    return;
  }

  // 3. Handle PANIC mode
  if (assessment.mode === 'PANIC') {
    await this.unwindPositionsAggressively();
    return;
  }

  // 4. Generate mode-aware quotes
  const quotes = this.strategy.generateQuotes(
    session, market, orderbook,
    assessment.mode,
    assessment.fragilityScore
  );

  // 5. Place orders
  await this.cancelAllOrders();
  await this.placeOrders(quotes);
}
```

---

## Logging

### Debug Output (LOG_LEVEL=DEBUG)

```json
{
  "edge": {
    "alive": true,
    "warning": false,
    "irreversible": false,
    "reason": "Edge alive"
  },
  "signals": {
    "fragilityScore": "0.150",
    "marketState": "NEUTRAL",
    "refillRate": "0.800",
    "isThinning": false
  },
  "risk": {
    "status": "NORMAL",
    "mode": "QUOTE",
    "urgency": "15.0%"
  }
}
```

### Mode Transitions (LOG_LEVEL=INFO)

```
[INFO] [4-Layer] Trading mode changed: QUOTE → INVENTORY
  reason: Position exceeds 50% of limit
  urgency: 55.0%
  fragility: 0.200
  edgeAlive: true
```

### Edge Death (LOG_LEVEL=WARN)

```
[WARN] [4-Layer] DEAD mode - edge died, stopping quotes
  reason: Low fragility score 0.05 (min: 0.10)
  irreversible: true
  fragilityScore: 0.050
  refillRate: 0.200
```

---

## Files

### Domain Layer

```
src/domain/services/
├── signals/
│   ├── TradeFlowAnalyzer.ts      # Trade flow analysis
│   ├── TradeSideDetector.ts      # Buy/sell detection
│   ├── OrderbookHealthMonitor.ts # Orderbook health
│   └── index.ts
├── risk/
│   ├── RiskAssessmentService.ts  # Main assessment
│   ├── EdgeAliveEvaluator.ts     # Edge detection
│   └── index.ts
└── strategies/
    └── TwoSidedMarketMaker.ts    # Quote generation
```

### Application Layer

```
src/application/orchestrators/
└── MainTradingOrchestrator.ts    # Integration point
```

### Infrastructure Layer

```
src/infrastructure/config/
├── EnvConfig.ts                  # All config variables
└── ConfigLoader.ts               # Config methods
```

---

## Configuration Summary

All 4-Layer configuration in `.env`:

```bash
# ========================================
# Layer 0: Edge Alive
# ========================================
EDGE_ALIVE_MIN_FRAGILITY_SCORE=0.1
EDGE_ALIVE_MIN_REFILL_RATE=0.3
EDGE_ALIVE_MIN_TIME_TO_EXPIRY_MIN=4
EDGE_ALIVE_WARMUP_MS=90000
EDGE_ALIVE_BAD_STREAK_TO_DEAD=4
EDGE_ALIVE_GOOD_STREAK_TO_REVIVE=2
EDGE_ALIVE_STREAK_DECAY_ALPHA=0.8

# ========================================
# Layer 1: Trade Flow
# ========================================
TRADE_FLOW_BOOK_LEVELS=2
TRADE_FLOW_BOOK_MIN_THRESHOLD=0.2
TRADE_FLOW_MIN_AGGRESSIVE_VOLUME=5
TRADE_FLOW_FRAGILITY_SCALE=5
TRADE_FLOW_DECAY_LAMBDA=0.002
TRADE_FLOW_TIME_TO_FILL_FAST=200
TRADE_FLOW_TIME_TO_FILL_MEDIUM=500
TRADE_FLOW_TIME_TO_FILL_SLOW=1000

# ========================================
# Layer 1: Orderbook Health
# ========================================
ORDERBOOK_HEALTH_MIN_DEPTH=20
ORDERBOOK_HEALTH_EMA_ALPHA=0.1
ORDERBOOK_HEALTH_SUMMARY_INTERVAL_MS=10000

# ========================================
# Layer 2: Risk Management
# ========================================
RISK_MAX_NET_POSITION=1000
RISK_MAX_GROSS_POSITION=2000
RISK_PANIC_THRESHOLD=0.8
RISK_INVENTORY_THRESHOLD=0.5
RISK_TIME_URGENCY_SECONDS=86400
```

# Architecture Guide: Value Objects

## Factory Method Naming Conventions

### Pattern 1: `fromValue()` - Single-Value Conversion

Used for value objects that wrap a single numeric value:

**Examples:**
- `Money.fromValue(100)` - amount in currency units
- `Price.fromValue(0.65)` - price value [0.0001, 0.9999]
- `Quantity.fromValue(100)` - quantity value
- `Balance.fromValue(1000, 'USDC')` - balance amount

**When to use:**
- Constructor takes 1-2 parameters (value + optional config like currency)
- Primary use case is converting number → value object

### Pattern 2: `create()` - Multi-Parameter Composition

Used for value objects composed from multiple other value objects:

**Examples:**
- `Spread.create(bid, ask)` - requires 2 Price objects
- `Quote.create(bid, ask, bidSize, askSize)` - requires 4 objects

**When to use:**
- Constructor requires multiple value object parameters
- Represents composition/aggregation of other value objects
- Primary use case is assembling from components

### Pattern 3: Domain-Specific Factories

Used for domain-specific conversion semantics:

**Examples:**
- `Percentage.fromDecimal(0.25)` - from decimal fraction [0-1]
- `Percentage.fromValue(25)` - from percentage points [0-100]
- `Percentage.fromBasisPoints(250)` - from basis points
- `Quantity.fromMarketData(data)` - from external API data

**When to use:**
- Multiple representations of the same concept
- Different scales or units (decimal vs percentage vs basis points)
- Different data sources (API vs user input)

### Pattern 4: Convenience Factories

Special case constructors for common values:

**Examples:**
- `Money.zero()` - zero amount
- `Quantity.zero()` - zero quantity
- `Spread.zero(price)` - zero-width spread

## When to Use Each Value Object

### Money vs Balance
- **Money**: General-purpose monetary value, supports negative (for PnL)
- **Balance**: User account balance, always non-negative, supports operations like `reserve()`

### Price vs Spread
- **Price**: Single price point [0.0001, 0.9999]
- **Spread**: Bid-ask pair with width calculations

### Percentage - Three Scales
- `fromDecimal(0.25)` → 25% (for calculations)
- `fromValue(25)` → 25% (for user input)
- `fromBasisPoints(250)` → 25% (for financial APIs)

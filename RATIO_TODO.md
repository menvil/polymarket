# Ratio Implementation TODO

## ✅ Phase 1: Ratio VO - COMPLETE
- [x] Ratio core value object
- [x] RatioService facade with wrapOp
- [x] RatioFormatter (decimal, percent, bps)
- [x] RatioSerializer (JSON)
- [x] Validation rules (GteMinusOne, LteOne)
- [x] Tests (176 tests passing)
- [x] Documentation

## 🚀 Phase 2: Spread methods with Ratio - IN PROGRESS

### High Priority
- [ ] `SpreadService.fromMidAndWidth(mid, width)` - создание из mid + абсолютная ширина
  - Input: mid (Decimal), width (Decimal)
  - Output: Spread с bid = mid - width/2, ask = mid + width/2
  - File: `src/spread/facade/SpreadService.ts:652`

- [ ] `SpreadService.fromMidAndWidthPercentage(mid, widthPct)` - создание из mid + % ширина
  - Input: mid (Decimal), widthPct (number - проценты)
  - Convert widthPct → Ratio → width = mid * ratio
  - Output: Spread с bid/ask
  - File: `src/spread/facade/SpreadService.ts:684`

### Medium Priority
- [ ] `SpreadService.widenBy(spread, ratio)` - расширить spread на %
  - Input: Spread, Ratio (например, 10% = 0.10)
  - Вычислить: currentWidth * (1 + ratio)
  - Output: новый Spread с увеличенной шириной

- [ ] `SpreadService.tightenBy(spread, ratio)` - сузить spread на %
  - Input: Spread, Ratio (например, 10% = 0.10)
  - Вычислить: currentWidth * (1 - ratio)
  - Output: новый Spread с уменьшенной шириной

## 📋 Phase 3: Service Integration

### OrderService
- [ ] Replace raw fee numbers with Ratio
- [ ] `calculateFees(amount, feeRatio)` → Money
- [ ] `applySlippageTolerance(price, slippageRatio)` → Price range

### QuoteService
- [ ] `addMarkup(quote, markupRatio)` → Quote
- [ ] `applyDiscount(quote, discountRatio)` → Quote
- [ ] `adjustSpreadWidth(spread, adjustmentRatio)` → Spread

### RiskService
- [ ] `validatePositionSize(balance, maxPositionRatio)` → boolean
- [ ] `calculateMaxExposure(balance, exposureRatio)` → Money
- [ ] `checkLimits(position, limitRatio)` → Result

### BalanceService
- [ ] `calculateReserve(balance, reserveRatio)` → Money
- [ ] `getAvailableBalance(balance, availabilityRatio)` → Money

## 🔧 Phase 4: Policies & Rules

### QuotingPolicy
- [ ] `VolatilityBasedQuotingPolicy` - adjust spread based on volatility
- [ ] `LiquidityBasedQuotingPolicy` - adjust spread based on liquidity
- [ ] `TimeBasedQuotingPolicy` - widen spread at market close

### FeePolicy
- [ ] `TieredFeePolicy` - different fees based on volume
- [ ] `MakerTakerFeePolicy` - different fees for makers/takers
- [ ] `PromotionalFeePolicy` - temporary fee discounts

### RiskPolicy
- [ ] `MaxPositionPolicy` - position limit as % of balance
- [ ] `ConcentrationPolicy` - max % in single market
- [ ] `LeveragePolicy` - max leverage ratio

## 📝 Documentation Tasks

- [ ] Add examples to CLAUDE.md for Ratio usage
- [ ] Update architecture docs with Ratio patterns
- [ ] Create migration guide for existing percentage code
- [ ] Add ADR (Architecture Decision Record) for Ratio vs Spread separation

## 🧪 Testing Tasks

- [ ] Integration tests for Spread + Ratio methods
- [ ] Performance tests for ratio operations
- [ ] Property-based tests for ratio arithmetic

## 🔍 Code Review Checklist

Before merging Ratio-related code:
- [ ] All tests passing (1384/1386 currently)
- [ ] Documentation updated
- [ ] Type safety maintained (no `any` types)
- [ ] Error handling follows Facade Error Contract
- [ ] Examples provided for new features

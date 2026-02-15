# Ratio Implementation TODO

## ✅ Phase 1: Ratio VO - COMPLETE
- [x] Ratio core value object
- [x] RatioService facade with wrapOp
- [x] RatioFormatter (decimal, percent, bps)
- [x] RatioSerializer (JSON)
- [x] Validation rules (GteMinusOne, LteOne)
- [x] Tests (176 tests passing)
- [x] Documentation

## ✅ Phase 2: Spread methods with Ratio - COMPLETE

### High Priority ✅
- [x] `SpreadService.fromMidAndWidth(mid, width)` - создание из mid + абсолютная ширина
  - Input: mid (Decimal), width (Decimal)
  - Output: Spread с bid = mid - width/2, ask = mid + width/2
  - Tests: 9 test cases
  - Commit: `89aa9d2`

- [x] `SpreadService.fromMidAndWidthPercentage(mid, widthPct, options?)` - создание из mid + % ширина
  - Input: mid (Decimal), widthPct (number - проценты)
  - Convert widthPct → Ratio → width = mid * ratio
  - Options: ensureLteOne для ограничения ширины <= 100%
  - Tests: 9 test cases
  - Commit: `89aa9d2`

### Medium Priority ✅
- [x] `SpreadService.widenBy(spread, ratio, options?)` - расширить spread на %
  - Input: Spread, ratio (Decimal как дробь, например 0.25 = 25%)
  - Вычислить: increase = currentWidth * ratio
  - Output: новый Spread с увеличенной шириной
  - Tests: 7 test cases
  - Commit: `89aa9d2`

- [x] `SpreadService.tightenBy(spread, ratio, options?)` - сузить spread на %
  - Input: Spread, ratio (Decimal как дробь)
  - Вычислить: decrease = currentWidth * ratio
  - Output: новый Spread с уменьшенной шириной
  - Tests: 9 test cases
  - Commit: `89aa9d2`

**Results**:
- ✅ 88 new tests added (1472 total, all passing)
- ✅ Full Facade Error Contract compliance
- ✅ wrapOp pattern for all methods
- ✅ Comprehensive documentation with examples

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

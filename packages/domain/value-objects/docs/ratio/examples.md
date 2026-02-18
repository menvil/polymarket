# Ratio Examples

Примеры использования Ratio в реальных сценариях.

## Содержание

- [Trading & Finance](#trading--finance)
- [E-Commerce](#e-commerce)
- [Pricing & Discounts](#pricing--discounts)
- [Analytics & Reporting](#analytics--reporting)
- [Configuration & Settings](#configuration--settings)
- [User Input Handling](#user-input-handling)
- [API Integration](#api-integration)
- [Complex Workflows](#complex-workflows)

## Trading & Finance

### Пример 1: Trading Fees (Maker/Taker)

```typescript
import { RatioService } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

class TradingFeeCalculator {
  private makerFee: Ratio;
  private takerFee: Ratio;

  constructor(makerFeePercent: number, takerFeePercent: number) {
    const makerResult = RatioService.fromPercent(makerFeePercent);
    const takerResult = RatioService.fromPercent(takerFeePercent);

    if (!makerResult.ok || !takerResult.ok) {
      throw new Error('Invalid fee configuration');
    }

    this.makerFee = makerResult.value;
    this.takerFee = takerResult.value;
  }

  calculateMakerFee(tradeAmount: Decimal): Decimal {
    // Fee = amount * feeRatio
    return tradeAmount.mul(this.makerFee.toDecimal());
  }

  calculateTakerFee(tradeAmount: Decimal): Decimal {
    return tradeAmount.mul(this.takerFee.toDecimal());
  }

  getNetMakerAmount(tradeAmount: Decimal): Decimal {
    // Net = amount * (1 - fee)
    return tradeAmount.mul(this.makerFee.oneMinus());
  }

  getNetTakerAmount(tradeAmount: Decimal): Decimal {
    return tradeAmount.mul(this.takerFee.oneMinus());
  }
}

// Usage
const calculator = new TradingFeeCalculator(0.1, 0.2); // 0.1% maker, 0.2% taker

const tradeAmount = new Decimal(10000);

const makerFee = calculator.calculateMakerFee(tradeAmount);
console.log(`Maker fee: $${makerFee.toFixed(2)}`); // "Maker fee: $10.00"

const netAmount = calculator.getNetMakerAmount(tradeAmount);
console.log(`Net amount after maker fee: $${netAmount.toFixed(2)}`); // "$9990.00"
```

### Пример 2: Spread Calculation (Bid/Ask)

```typescript
import { RatioService, RatioFormatter } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

class SpreadCalculator {
  /**
   * Вычислить bid/ask цены из mid price и spread
   */
  static calculatePrices(
    midPrice: Decimal,
    spreadBps: number
  ): { bid: Decimal; ask: Decimal; spread: Ratio } | null {
    const spreadResult = RatioService.fromBps(spreadBps);

    if (!spreadResult.ok) {
      console.error('Invalid spread:', spreadResult.error);
      return null;
    }

    const spread = spreadResult.value;

    // Half spread для каждой стороны
    const halfSpread = spread.toDecimal().div(2);

    // Ask = mid * (1 + halfSpread)
    const ask = midPrice.mul(new Decimal(1).plus(halfSpread));

    // Bid = mid * (1 - halfSpread)
    const bid = midPrice.mul(new Decimal(1).minus(halfSpread));

    return { bid, ask, spread };
  }

  /**
   * Вычислить spread из bid/ask цен
   */
  static calculateSpread(bid: Decimal, ask: Decimal): Result<Ratio, string> {
    if (bid.gte(ask)) {
      return Err('Bid must be less than ask');
    }

    const mid = bid.plus(ask).div(2);
    const spreadValue = ask.minus(bid).div(mid);

    const spreadResult = RatioService.fromDecimal(spreadValue);

    if (!spreadResult.ok) {
      return Err(`Invalid spread: ${spreadResult.error.message}`);
    }

    return Ok(spreadResult.value);
  }
}

// Usage 1: Calculate bid/ask from spread
const midPrice = new Decimal(100);
const spreadBps = 50; // 50 bps = 0.5%

const prices = SpreadCalculator.calculatePrices(midPrice, spreadBps);
if (prices) {
  console.log(`Mid: $${midPrice}`);
  console.log(`Bid: $${prices.bid.toFixed(2)}`); // "$99.75"
  console.log(`Ask: $${prices.ask.toFixed(2)}`); // "$100.25"

  const formatted = RatioFormatter.toBps(prices.spread, 0);
  console.log(`Spread: ${formatted.value}`); // "50 bps"
}

// Usage 2: Calculate spread from bid/ask
const bid = new Decimal(99.75);
const ask = new Decimal(100.25);

const spreadResult = SpreadCalculator.calculateSpread(bid, ask);
if (spreadResult.ok) {
  const formatted = RatioFormatter.toBps(spreadResult.value, 1);
  console.log(`Calculated spread: ${formatted.value}`); // "50.0 bps"
}
```

### Пример 3: Portfolio Allocation

```typescript
import { RatioService } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

interface AssetAllocation {
  symbol: string;
  ratio: Ratio;
}

class Portfolio {
  private allocations: AssetAllocation[];

  constructor(allocations: Array<{ symbol: string; percent: number }>) {
    this.allocations = allocations.map(({ symbol, percent }) => {
      const ratioResult = RatioService.fromPercent(percent);

      if (!ratioResult.ok) {
        throw new Error(`Invalid allocation for ${symbol}`);
      }

      return { symbol, ratio: ratioResult.value };
    });

    // Валидация: сумма должна быть 100%
    const totalRatio = this.allocations.reduce(
      (sum, { ratio }) => sum.plus(ratio.toDecimal()),
      new Decimal(0)
    );

    const hundredPercent = new Decimal(1);
    if (!totalRatio.equals(hundredPercent)) {
      throw new Error(`Total allocation must be 100%, got ${totalRatio.mul(100)}%`);
    }
  }

  calculateAmounts(totalCapital: Decimal): Map<string, Decimal> {
    const amounts = new Map<string, Decimal>();

    for (const { symbol, ratio } of this.allocations) {
      const amount = totalCapital.mul(ratio.toDecimal());
      amounts.set(symbol, amount);
    }

    return amounts;
  }

  rebalance(
    currentAmounts: Map<string, Decimal>,
    totalCapital: Decimal
  ): Map<string, Decimal> {
    const targetAmounts = this.calculateAmounts(totalCapital);
    const adjustments = new Map<string, Decimal>();

    for (const { symbol } of this.allocations) {
      const current = currentAmounts.get(symbol) || new Decimal(0);
      const target = targetAmounts.get(symbol) || new Decimal(0);
      const adjustment = target.minus(current);
      adjustments.set(symbol, adjustment);
    }

    return adjustments;
  }
}

// Usage
const portfolio = new Portfolio([
  { symbol: 'BTC', percent: 40 },
  { symbol: 'ETH', percent: 30 },
  { symbol: 'USDC', percent: 30 }
]);

const totalCapital = new Decimal(100000);
const amounts = portfolio.calculateAmounts(totalCapital);

console.log('Target allocation:');
for (const [symbol, amount] of amounts.entries()) {
  console.log(`${symbol}: $${amount.toFixed(2)}`);
}
// BTC: $40000.00
// ETH: $30000.00
// USDC: $30000.00

// Rebalancing
const currentAmounts = new Map([
  ['BTC', new Decimal(45000)],
  ['ETH', new Decimal(28000)],
  ['USDC', new Decimal(27000)]
]);

const adjustments = portfolio.rebalance(currentAmounts, totalCapital);
console.log('\nRebalancing needed:');
for (const [symbol, adjustment] of adjustments.entries()) {
  const sign = adjustment.isPositive() ? '+' : '';
  console.log(`${symbol}: ${sign}$${adjustment.toFixed(2)}`);
}
// BTC: -$5000.00 (sell)
// ETH: +$2000.00 (buy)
// USDC: +$3000.00 (buy)
```

## E-Commerce

### Пример 4: Tax Calculation

```typescript
import { RatioService } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

class TaxCalculator {
  private taxRate: Ratio;

  constructor(taxPercent: number) {
    const result = RatioService.fromPercent(taxPercent, { ensureGteMinusOne: true });

    if (!result.ok) {
      throw new Error(`Invalid tax rate: ${result.error.message}`);
    }

    this.taxRate = result.value;
  }

  calculateTax(amount: Decimal): Decimal {
    return amount.mul(this.taxRate.toDecimal());
  }

  calculateGross(net: Decimal): Decimal {
    // gross = net * (1 + taxRate)
    return net.mul(this.taxRate.onePlus());
  }

  calculateNet(gross: Decimal): Decimal {
    // net = gross / (1 + taxRate)
    return gross.div(this.taxRate.onePlus());
  }

  breakdown(amount: Decimal): { net: Decimal; tax: Decimal; gross: Decimal } {
    const net = amount;
    const tax = this.calculateTax(net);
    const gross = net.plus(tax);

    return { net, tax, gross };
  }
}

// Usage
const calculator = new TaxCalculator(20); // 20% VAT

const netPrice = new Decimal(100);
const breakdown = calculator.breakdown(netPrice);

console.log(`Net price: $${breakdown.net.toFixed(2)}`);   // "$100.00"
console.log(`Tax (20%): $${breakdown.tax.toFixed(2)}`);   // "$20.00"
console.log(`Gross price: $${breakdown.gross.toFixed(2)}`); // "$120.00"

// Reverse calculation
const grossPrice = new Decimal(120);
const calculatedNet = calculator.calculateNet(grossPrice);
console.log(`Net from gross: $${calculatedNet.toFixed(2)}`); // "$100.00"
```

### Пример 5: Shipping Cost Calculator

```typescript
import { RatioService, RatioFormatter } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

class ShippingCalculator {
  private freeShippingThreshold: Decimal;
  private baseCost: Decimal;
  private insuranceRate: Ratio;

  constructor(
    freeShippingThreshold: Decimal,
    baseCost: Decimal,
    insurancePercent: number
  ) {
    this.freeShippingThreshold = freeShippingThreshold;
    this.baseCost = baseCost;

    const insuranceResult = RatioService.fromPercent(insurancePercent);
    if (!insuranceResult.ok) {
      throw new Error('Invalid insurance rate');
    }

    this.insuranceRate = insuranceResult.value;
  }

  calculate(
    orderAmount: Decimal,
    includeInsurance: boolean
  ): { shipping: Decimal; insurance: Decimal; total: Decimal } {
    let shipping = new Decimal(0);

    // Free shipping если сумма >= threshold
    if (orderAmount.lt(this.freeShippingThreshold)) {
      shipping = this.baseCost;
    }

    // Insurance = orderAmount * insuranceRate
    const insurance = includeInsurance
      ? orderAmount.mul(this.insuranceRate.toDecimal())
      : new Decimal(0);

    const total = shipping.plus(insurance);

    return { shipping, insurance, total };
  }
}

// Usage
const calculator = new ShippingCalculator(
  new Decimal(50),  // Free shipping over $50
  new Decimal(5),   // $5 base shipping
  1                 // 1% insurance
);

// Order below threshold
const order1 = new Decimal(30);
const cost1 = calculator.calculate(order1, true);
console.log(`Order $${order1}:`);
console.log(`  Shipping: $${cost1.shipping.toFixed(2)}`);  // "$5.00"
console.log(`  Insurance: $${cost1.insurance.toFixed(2)}`); // "$0.30"
console.log(`  Total: $${cost1.total.toFixed(2)}`);        // "$5.30"

// Order above threshold
const order2 = new Decimal(75);
const cost2 = calculator.calculate(order2, true);
console.log(`\nOrder $${order2}:`);
console.log(`  Shipping: $${cost2.shipping.toFixed(2)}`);  // "$0.00" (free)
console.log(`  Insurance: $${cost2.insurance.toFixed(2)}`); // "$0.75"
console.log(`  Total: $${cost2.total.toFixed(2)}`);        // "$0.75"
```

## Pricing & Discounts

### Пример 6: Tiered Discount System

```typescript
import { RatioService, RatioFormatter } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

interface DiscountTier {
  minQuantity: number;
  discountPercent: number;
}

class TieredDiscountPricing {
  private tiers: Array<{ minQuantity: number; discount: Ratio }>;

  constructor(tiers: DiscountTier[]) {
    // Сортируем по возрастанию количества
    const sorted = [...tiers].sort((a, b) => a.minQuantity - b.minQuantity);

    this.tiers = sorted.map(({ minQuantity, discountPercent }) => {
      const discountResult = RatioService.fromPercent(discountPercent, {
        ensureGteMinusOne: true
      });

      if (!discountResult.ok) {
        throw new Error(`Invalid discount for tier ${minQuantity}`);
      }

      return { minQuantity, discount: discountResult.value };
    });
  }

  getDiscount(quantity: number): Ratio {
    // Найти максимальный tier, который применяется
    let applicableDiscount = Ratio.ZERO;

    for (const { minQuantity, discount } of this.tiers) {
      if (quantity >= minQuantity) {
        applicableDiscount = discount;
      } else {
        break;
      }
    }

    return applicableDiscount;
  }

  calculatePrice(basePrice: Decimal, quantity: number): {
    baseTotal: Decimal;
    discount: Ratio;
    discountAmount: Decimal;
    finalPrice: Decimal;
  } {
    const baseTotal = basePrice.mul(quantity);
    const discount = this.getDiscount(quantity);

    // Discount amount = baseTotal * discount
    const discountAmount = baseTotal.mul(discount.toDecimal());

    // Final = base - discount = base * (1 - discount)
    const finalPrice = baseTotal.mul(discount.oneMinus());

    return { baseTotal, discount, discountAmount, finalPrice };
  }
}

// Usage
const pricing = new TieredDiscountPricing([
  { minQuantity: 1, discountPercent: 0 },    // No discount
  { minQuantity: 10, discountPercent: 5 },   // 5% off for 10+
  { minQuantity: 50, discountPercent: 10 },  // 10% off for 50+
  { minQuantity: 100, discountPercent: 15 }  // 15% off for 100+
]);

const unitPrice = new Decimal(10);

function printPricing(quantity: number) {
  const result = pricing.calculatePrice(unitPrice, quantity);
  const discountFormatted = RatioFormatter.toPercent(result.discount, 0);

  console.log(`\nQuantity: ${quantity}`);
  console.log(`  Base total: $${result.baseTotal.toFixed(2)}`);
  console.log(`  Discount: ${discountFormatted.value}`);
  console.log(`  Discount amount: -$${result.discountAmount.toFixed(2)}`);
  console.log(`  Final price: $${result.finalPrice.toFixed(2)}`);
}

printPricing(5);   // 0% discount
printPricing(25);  // 5% discount
printPricing(75);  // 10% discount
printPricing(150); // 15% discount
```

### Пример 7: Dynamic Pricing with Time-based Markup

```typescript
import { RatioService } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

class DynamicPricing {
  private basePrice: Decimal;
  private peakHourMarkup: Ratio;
  private offPeakDiscount: Ratio;

  constructor(
    basePrice: Decimal,
    peakHourMarkupPercent: number,
    offPeakDiscountPercent: number
  ) {
    this.basePrice = basePrice;

    const markupResult = RatioService.fromPercent(peakHourMarkupPercent, {
      ensureGteMinusOne: true
    });
    const discountResult = RatioService.fromPercent(offPeakDiscountPercent, {
      ensureGteMinusOne: true
    });

    if (!markupResult.ok || !discountResult.ok) {
      throw new Error('Invalid pricing configuration');
    }

    this.peakHourMarkup = markupResult.value;
    this.offPeakDiscount = discountResult.value;
  }

  getPriceAt(hour: number): Decimal {
    // Peak hours: 12-14, 18-20
    const isPeakHour =
      (hour >= 12 && hour < 14) || (hour >= 18 && hour < 20);

    // Off-peak: 0-6, 22-24
    const isOffPeak = hour < 6 || hour >= 22;

    if (isPeakHour) {
      // Price * (1 + markup)
      return this.basePrice.mul(this.peakHourMarkup.onePlus());
    } else if (isOffPeak) {
      // Price * (1 - discount) = Price * (1 + negative_discount)
      return this.basePrice.mul(this.offPeakDiscount.onePlus());
    } else {
      // Regular price
      return this.basePrice;
    }
  }

  getDailyPrices(): Map<number, Decimal> {
    const prices = new Map<number, Decimal>();

    for (let hour = 0; hour < 24; hour++) {
      prices.set(hour, this.getPriceAt(hour));
    }

    return prices;
  }
}

// Usage
const pricing = new DynamicPricing(
  new Decimal(100), // $100 base price
  20,               // +20% peak hour markup
  -15               // -15% off-peak discount (negative %)
);

console.log('Dynamic pricing for 24 hours:');
console.log(`Regular (10am): $${pricing.getPriceAt(10).toFixed(2)}`);  // "$100.00"
console.log(`Peak (1pm): $${pricing.getPriceAt(13).toFixed(2)}`);      // "$120.00"
console.log(`Off-peak (2am): $${pricing.getPriceAt(2).toFixed(2)}`);   // "$85.00"
```

## Analytics & Reporting

### Пример 8: Performance Metrics

```typescript
import { RatioService, RatioFormatter } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

class PerformanceAnalyzer {
  static calculateChange(
    oldValue: Decimal,
    newValue: Decimal
  ): Result<Ratio, string> {
    if (oldValue.isZero()) {
      return Err('Cannot calculate change from zero');
    }

    // Change = (new - old) / old
    const changeValue = newValue.minus(oldValue).div(oldValue);

    return RatioService.fromDecimal(changeValue);
  }

  static formatChange(ratio: Ratio): string {
    const percentResult = RatioFormatter.toPercent(ratio, 2);
    if (!percentResult.ok) {
      return 'N/A';
    }

    const emoji = ratio.isPositive() ? '📈' : ratio.isNegative() ? '📉' : '➡️';
    return `${emoji} ${percentResult.value}`;
  }

  static analyzeMetrics(metrics: {
    revenue: { old: Decimal; new: Decimal };
    users: { old: Decimal; new: Decimal };
    avgOrderValue: { old: Decimal; new: Decimal };
  }): void {
    console.log('Performance Analysis:');
    console.log('===================');

    // Revenue
    const revenueChange = this.calculateChange(metrics.revenue.old, metrics.revenue.new);
    if (revenueChange.ok) {
      console.log(`Revenue: ${this.formatChange(revenueChange.value)}`);
    }

    // Users
    const usersChange = this.calculateChange(metrics.users.old, metrics.users.new);
    if (usersChange.ok) {
      console.log(`Users: ${this.formatChange(usersChange.value)}`);
    }

    // AOV
    const aovChange = this.calculateChange(metrics.avgOrderValue.old, metrics.avgOrderValue.new);
    if (aovChange.ok) {
      console.log(`Avg Order Value: ${this.formatChange(aovChange.value)}`);
    }
  }
}

// Usage
PerformanceAnalyzer.analyzeMetrics({
  revenue: {
    old: new Decimal(100000),
    new: new Decimal(125000)
  },
  users: {
    old: new Decimal(5000),
    new: new Decimal(5500)
  },
  avgOrderValue: {
    old: new Decimal(50),
    new: new Decimal(55)
  }
});
// Performance Analysis:
// ===================
// Revenue: 📈 25.00%
// Users: 📈 10.00%
// Avg Order Value: 📈 10.00%
```

## Configuration & Settings

### Пример 9: Application Configuration

```typescript
import { RatioService, RatioSerializer } from '@polymarket/value-objects';

interface AppConfig {
  fees: {
    transaction: RatioJSON;
    withdrawal: RatioJSON;
    platform: RatioJSON;
  };
  limits: {
    maxSlippage: RatioJSON;
    stopLoss: RatioJSON;
  };
}

class ConfigManager {
  private config: {
    fees: {
      transaction: Ratio;
      withdrawal: Ratio;
      platform: Ratio;
    };
    limits: {
      maxSlippage: Ratio;
      stopLoss: Ratio;
    };
  };

  constructor(jsonConfig: AppConfig) {
    // Deserialize all ratios from JSON
    const transactionFee = RatioSerializer.fromJSON(jsonConfig.fees.transaction);
    const withdrawalFee = RatioSerializer.fromJSON(jsonConfig.fees.withdrawal);
    const platformFee = RatioSerializer.fromJSON(jsonConfig.fees.platform);
    const maxSlippage = RatioSerializer.fromJSON(jsonConfig.limits.maxSlippage);
    const stopLoss = RatioSerializer.fromJSON(jsonConfig.limits.stopLoss);

    if (
      !transactionFee.ok ||
      !withdrawalFee.ok ||
      !platformFee.ok ||
      !maxSlippage.ok ||
      !stopLoss.ok
    ) {
      throw new Error('Invalid configuration');
    }

    this.config = {
      fees: {
        transaction: transactionFee.value,
        withdrawal: withdrawalFee.value,
        platform: platformFee.value
      },
      limits: {
        maxSlippage: maxSlippage.value,
        stopLoss: stopLoss.value
      }
    };
  }

  getFees() {
    return this.config.fees;
  }

  getLimits() {
    return this.config.limits;
  }

  toJSON(): AppConfig {
    return {
      fees: {
        transaction: RatioSerializer.toJSON(this.config.fees.transaction),
        withdrawal: RatioSerializer.toJSON(this.config.fees.withdrawal),
        platform: RatioSerializer.toJSON(this.config.fees.platform)
      },
      limits: {
        maxSlippage: RatioSerializer.toJSON(this.config.limits.maxSlippage),
        stopLoss: RatioSerializer.toJSON(this.config.limits.stopLoss)
      }
    };
  }
}

// Usage
const jsonConfig: AppConfig = {
  fees: {
    transaction: { ratio: "0.001" }, // 0.1%
    withdrawal: { ratio: "0.002" },  // 0.2%
    platform: { ratio: "0.0025" }    // 0.25%
  },
  limits: {
    maxSlippage: { ratio: "0.01" },  // 1%
    stopLoss: { ratio: "-0.05" }     // -5%
  }
};

const config = new ConfigManager(jsonConfig);

// Use config
const fees = config.getFees();
const amount = new Decimal(1000);

const transactionFee = amount.mul(fees.transaction.toDecimal());
console.log(`Transaction fee: $${transactionFee.toFixed(2)}`); // "$1.00"

// Serialize back to JSON
const serialized = config.toJSON();
console.log(JSON.stringify(serialized, null, 2));
```

## User Input Handling

### Пример 10: Form Validation

```typescript
import { RatioService, RatioFormatter } from '@polymarket/value-objects';
import { isErr } from '@polymarket/result';

class DiscountFormValidator {
  static validateAndParse(input: string): {
    valid: boolean;
    ratio?: Ratio;
    error?: string;
  } {
    // Try parsing
    const result = RatioFormatter.parse(input);

    if (isErr(result)) {
      return {
        valid: false,
        error: 'Please enter a valid discount (e.g., "10%", "0.1", "1000 bps")'
      };
    }

    const ratio = result.value;

    // Business rule: discount must be between 0% and 50%
    if (ratio.isNegative()) {
      return {
        valid: false,
        error: 'Discount cannot be negative'
      };
    }

    const fiftyPercent = RatioService.fromPercent(50);
    if (fiftyPercent.ok && ratio.toDecimal().gt(fiftyPercent.value.toDecimal())) {
      return {
        valid: false,
        error: 'Discount cannot exceed 50%'
      };
    }

    return {
      valid: true,
      ratio
    };
  }
}

// Usage
const inputs = ["10%", "0.25", "500 bps", "-5%", "60%", "invalid"];

for (const input of inputs) {
  const result = DiscountFormValidator.validateAndParse(input);

  if (result.valid && result.ratio) {
    const formatted = RatioFormatter.toPercent(result.ratio, 1);
    console.log(`✅ "${input}" → ${formatted.value}`);
  } else {
    console.log(`❌ "${input}" → ${result.error}`);
  }
}
// ✅ "10%" → 10.0%
// ✅ "0.25" → 25.0%
// ✅ "500 bps" → 5.0%
// ❌ "-5%" → Discount cannot be negative
// ❌ "60%" → Discount cannot exceed 50%
// ❌ "invalid" → Please enter a valid discount
```

## API Integration

### Пример 11: REST API with Ratio

```typescript
import { RatioService, RatioSerializer, RatioFormatter } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// API Request/Response types
interface CreateOrderRequest {
  amount: string;
  maxSlippagePercent: number;
}

interface OrderResponse {
  orderId: string;
  amount: string;
  maxSlippage: RatioJSON;
  estimatedPrice: string;
  worstCasePrice: string;
}

class OrderAPI {
  static async createOrder(req: CreateOrderRequest): Promise<OrderResponse> {
    const amount = new Decimal(req.amount);

    // Parse slippage from percent
    const slippageResult = RatioService.fromPercent(req.maxSlippagePercent, {
      ensureGteMinusOne: true
    });

    if (!slippageResult.ok) {
      throw new Error(`Invalid slippage: ${slippageResult.error.message}`);
    }

    const slippage = slippageResult.value;

    // Simulate price calculation
    const estimatedPrice = new Decimal(100);

    // Worst case = estimated * (1 + slippage)
    const worstCasePrice = estimatedPrice.mul(slippage.onePlus());

    return {
      orderId: `order-${Date.now()}`,
      amount: amount.toString(),
      maxSlippage: RatioSerializer.toJSON(slippage),
      estimatedPrice: estimatedPrice.toString(),
      worstCasePrice: worstCasePrice.toString()
    };
  }

  static parseOrderResponse(response: OrderResponse): {
    orderId: string;
    maxSlippage: Ratio;
    estimatedPrice: Decimal;
    worstCasePrice: Decimal;
  } | null {
    const slippageResult = RatioSerializer.fromJSON(response.maxSlippage);

    if (!slippageResult.ok) {
      console.error('Invalid slippage in response');
      return null;
    }

    return {
      orderId: response.orderId,
      maxSlippage: slippageResult.value,
      estimatedPrice: new Decimal(response.estimatedPrice),
      worstCasePrice: new Decimal(response.worstCasePrice)
    };
  }
}

// Usage
async function placeOrder() {
  const request: CreateOrderRequest = {
    amount: "1000",
    maxSlippagePercent: 1 // 1%
  };

  const response = await OrderAPI.createOrder(request);
  console.log('Order created:', JSON.stringify(response, null, 2));

  const parsed = OrderAPI.parseOrderResponse(response);
  if (parsed) {
    const slippageFormatted = RatioFormatter.toPercent(parsed.maxSlippage, 2);
    console.log(`\nParsed order:`);
    console.log(`  ID: ${parsed.orderId}`);
    console.log(`  Max slippage: ${slippageFormatted.value}`);
    console.log(`  Estimated: $${parsed.estimatedPrice.toFixed(2)}`);
    console.log(`  Worst case: $${parsed.worstCasePrice.toFixed(2)}`);
  }
}
```

## Complex Workflows

### Пример 12: Multi-step Price Calculation

```typescript
import { RatioService } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

class ComplexPricingCalculator {
  /**
   * Многошаговый расчет цены:
   * 1. Базовая цена
   * 2. + Markup
   * 3. - Discount
   * 4. + Tax
   * 5. + Fee
   */
  static calculate(
    basePrice: Decimal,
    markupPercent: number,
    discountPercent: number,
    taxPercent: number,
    feePercent: number
  ): {
    steps: Array<{ step: string; amount: Decimal }>;
    final: Decimal;
  } | null {
    // Parse all ratios
    const markupResult = RatioService.fromPercent(markupPercent, { ensureGteMinusOne: true });
    const discountResult = RatioService.fromPercent(-Math.abs(discountPercent), { ensureGteMinusOne: true });
    const taxResult = RatioService.fromPercent(taxPercent);
    const feeResult = RatioService.fromPercent(feePercent);

    if (!markupResult.ok || !discountResult.ok || !taxResult.ok || !feeResult.ok) {
      return null;
    }

    const steps: Array<{ step: string; amount: Decimal }> = [];

    // Step 1: Base price
    let current = basePrice;
    steps.push({ step: 'Base price', amount: current });

    // Step 2: Apply markup
    current = current.mul(markupResult.value.onePlus());
    steps.push({ step: `+ Markup (${markupPercent}%)`, amount: current });

    // Step 3: Apply discount
    current = current.mul(discountResult.value.onePlus());
    steps.push({ step: `- Discount (${discountPercent}%)`, amount: current });

    // Step 4: Add tax
    const taxAmount = current.mul(taxResult.value.toDecimal());
    current = current.plus(taxAmount);
    steps.push({ step: `+ Tax (${taxPercent}%)`, amount: current });

    // Step 5: Add fee
    const feeAmount = current.mul(feeResult.value.toDecimal());
    current = current.plus(feeAmount);
    steps.push({ step: `+ Fee (${feePercent}%)`, amount: current });

    return {
      steps,
      final: current
    };
  }
}

// Usage
const result = ComplexPricingCalculator.calculate(
  new Decimal(100), // Base price
  10,               // +10% markup
  15,               // -15% discount
  20,               // +20% tax
  2                 // +2% fee
);

if (result) {
  console.log('Price calculation breakdown:');
  for (const { step, amount } of result.steps) {
    console.log(`  ${step.padEnd(25)} $${amount.toFixed(2)}`);
  }
  console.log(`\nFinal price: $${result.final.toFixed(2)}`);
}
// Price calculation breakdown:
//   Base price                $100.00
//   + Markup (10%)            $110.00
//   - Discount (15%)          $93.50
//   + Tax (20%)               $112.20
//   + Fee (2%)                $114.44
//
// Final price: $114.44
```

## Следующие шаги

- [Core API Reference](./core.md) - Ratio class методы
- [Facade API Reference](./facade.md) - RatioService factory methods
- [Adapters](./adapters.md) - RatioFormatter и RatioSerializer
- [Comparison with Percentage](./comparison-with-percentage.md) - почему Percentage был удален

# Предложения по улучшению Quote

## Текущее состояние

### QuoteService (Facade) - 8 методов
**Factory:**
- ✅ create() - two-sided quote
- ✅ bidOnly() - bid-only quote
- ✅ askOnly() - ask-only quote

**Manipulation:**
- ✅ shift() - сдвиг обеих сторон
- ✅ skew() - независимый сдвиг bid/ask
- ✅ updateSizes() - обновление размеров

**Query:**
- ✅ getSpreadOrZero() - spread или 0
- ✅ getMidPrice() - mid price или null

### Quote Core - 13 методов
**Getters:**
- ✅ bid(), ask(), bidSize(), askSize()
- ✅ timestampMs(), getTimestamp()

**Predicates:**
- ✅ isTwoSided(), hasBid(), hasAsk()

**Calculations:**
- ✅ spread() - Spread объект
- ✅ age() - возраст котировки

**Comparison:**
- ✅ equals(), equalsWithTimestamp()

### Rules - 4 правила
- ✅ ValidateMarketCrossing - bid > ask
- ✅ ValidateMaxSpread - max width
- ✅ ValidateMinSpread - min width
- ✅ ValidateQuoteSizes - min/max sizes

### Adapters - 2 адаптера
- ✅ QuoteFormatter - форматирование
- ✅ QuoteSerializer - JSON сериализация

---

## 🚀 Предложения по улучшению

### 1. QuoteService (Facade) - новые методы

#### 1.1 Операции с ценами

**`improveBid(quote, improvement)`** - улучшение bid (поднять цену)
```typescript
public static improveBid(
  quote: Quote,
  improvement: Decimal | number | string
): Result<Quote, InvalidQuoteError>
```
**Use case:** Market maker хочет быть более агрессивным на bid стороне
```typescript
// Было: bid=0.48, ask=0.52
// Улучшаем bid на 0.01
const result = QuoteService.improveBid(quote, 0.01);
// Стало: bid=0.49, ask=0.52 (spread сузился)
```

**`improveAsk(quote, improvement)`** - улучшение ask (понизить цену)
```typescript
public static improaseAsk(
  quote: Quote,
  improvement: Decimal | number | string
): Result<Quote, InvalidQuoteError>
```
**Use case:** Сделать ask более привлекательной для покупателей

**`worsenBid(quote, worsening)`** - ухудшение bid (понизить цену)
```typescript
public static worsenBid(
  quote: Quote,
  worsening: Decimal | number | string
): Result<Quote, InvalidQuoteError>
```
**Use case:** Защита от adverse selection, расширение spread

**`worsenAsk(quote, worsening)`** - ухудшение ask (поднять цену)

---

#### 1.2 Операции со spread

**`widenSpread(quote, widthIncrease)`** - расширить spread симметрично
```typescript
public static widenSpread(
  quote: Quote,
  widthIncrease: Decimal | number | string
): Result<Quote, InvalidQuoteError>
```
**Use case:** Увеличение защиты от риска
```typescript
// Было: bid=0.48, ask=0.52, spread=0.04
// Расширяем на 0.02 (по 0.01 с каждой стороны)
const result = QuoteService.widenSpread(quote, 0.02);
// Стало: bid=0.47, ask=0.53, spread=0.06
```

**`narrowSpread(quote, widthDecrease)`** - сузить spread симметрично
```typescript
public static narrowSpread(
  quote: Quote,
  widthDecrease: Decimal | number | string
): Result<Quote, InvalidQuoteError>
```
**Use case:** Более агрессивное котирование, привлечение объема

**`setSpreadWidth(quote, targetWidth)`** - установить конкретную ширину spread
```typescript
public static setSpreadWidth(
  quote: Quote,
  targetWidth: Decimal | number | string
): Result<Quote, InvalidQuoteError>
```
**Use case:** Привести spread к целевому значению (вокруг mid)

---

#### 1.3 Операции с размерами

**`scaleSize(quote, factor)`** - пропорциональное изменение размеров
```typescript
public static scaleSize(
  quote: Quote,
  factor: Decimal | number | string
): Result<Quote, InvalidQuoteError>
```
**Use case:** Увеличить/уменьшить ликвидность
```typescript
// Было: bidSize=100, askSize=150
// Удваиваем размеры
const result = QuoteService.scaleSize(quote, 2);
// Стало: bidSize=200, askSize=300
```

**`setBidSize(quote, newSize)`** - обновить только bid size
```typescript
public static setBidSize(
  quote: Quote,
  newSize: Decimal | number | string | Quantity
): Result<Quote, InvalidQuoteError>
```

**`setAskSize(quote, newSize)`** - обновить только ask size

---

#### 1.4 Нормализация

**`roundToTickSize(quote, tickSize)`** - округлить цены к tick size
```typescript
public static roundToTickSize(
  quote: Quote,
  tickSize: Decimal | number | string
): Result<Quote, InvalidQuoteError>
```
**Use case:** Привести котировку к требованиям биржи
```typescript
// Было: bid=0.4823, ask=0.5177
// Округляем к tickSize=0.01
const result = QuoteService.roundToTickSize(quote, 0.01);
// Стало: bid=0.48, ask=0.52
```

**`alignToGrid(quote, priceGrid)`** - привести к ценовой сетке
```typescript
public static alignToGrid(
  quote: Quote,
  priceGrid: Decimal | number | string
): Result<Quote, InvalidQuoteError>
```
**Use case:** Выравнивание по кратным ценам (0.05, 0.10, 0.15...)

---

#### 1.5 Комбинирование котировок

**`merge(quote1, quote2, strategy)`** - объединить две котировки
```typescript
public static merge(
  quote1: Quote,
  quote2: Quote,
  strategy: 'best' | 'worst' | 'average'
): Result<Quote, InvalidQuoteError>
```
**Use case:** Агрегация котировок от разных источников
```typescript
// quote1: bid=0.48, ask=0.52
// quote2: bid=0.49, ask=0.51
// strategy='best': bid=0.49 (лучший), ask=0.51 (лучший)
const result = QuoteService.merge(quote1, quote2, 'best');
```

**`weightedMerge(quotes, weights)`** - взвешенное объединение
```typescript
public static weightedMerge(
  quotes: Quote[],
  weights: number[]
): Result<Quote, InvalidQuoteError>
```
**Use case:** Агрегация с учетом доверия к источнику

---

#### 1.6 Конверсия и трансформация

**`flip(quote)`** - инверсия для противоположной стороны рынка
```typescript
public static flip(quote: Quote): Result<Quote, InvalidQuoteError>
```
**Use case:** Создание синтетической котировки для обратной пары
```typescript
// Рынок YES: bid=0.48, ask=0.52
// Создаем котировку для NO (инверсия)
const noQuote = QuoteService.flip(yesQuote);
// NO: bid=0.48 (1-0.52), ask=0.52 (1-0.48)
```

**`applySkew(quote, skewPercentage)`** - применить процентный skew
```typescript
public static applySkew(
  quote: Quote,
  skewPercentage: Decimal | number | string
): Result<Quote, InvalidQuoteError>
```
**Use case:** Процентный сдвиг от mid (±%)

---

#### 1.7 Валидация и проверки

**`isStale(quote, maxAge)`** - проверка свежести котировки
```typescript
public static isStale(
  quote: Quote,
  maxAgeMs: number
): boolean
```
**Use case:** Проверить не устарела ли котировка
```typescript
if (QuoteService.isStale(quote, 5000)) {
  console.log('Quote older than 5 seconds');
}
```

**`isCompetitive(quote, benchmark, threshold)`** - сравнение с бенчмарком
```typescript
public static isCompetitive(
  quote: Quote,
  benchmark: Quote,
  threshold: Decimal | number | string
): boolean
```
**Use case:** Проверить конкурентоспособность котировки

**`qualityScore(quote)`** - оценка качества котировки
```typescript
public static qualityScore(quote: Quote): Decimal
```
**Use case:** Scoring на основе spread, size, freshness
```typescript
// Чем меньше spread и больше size, тем лучше score
const score = QuoteService.qualityScore(quote); // 0-100
```

---

### 2. Quote Core - новые методы

#### 2.1 Дополнительные query методы

**`spreadPercentage()`** - spread в процентах от mid
```typescript
public spreadPercentage(): Decimal | null
```
```typescript
// bid=0.48, ask=0.52, mid=0.50
// spread=0.04, percentage=8%
const pct = quote.spreadPercentage(); // 8.0
```

**`effectiveSpread()`** - effective spread (для анализа)
```typescript
public effectiveSpread(): Decimal | null
```

**`imbalance()`** - дисбаланс размеров (bidSize vs askSize)
```typescript
public imbalance(): Decimal
```
```typescript
// bidSize=100, askSize=150
// imbalance = (100-150)/(100+150) = -0.2 (20% в сторону ask)
const imb = quote.imbalance(); // -0.2
```

**`totalSize()`** - суммарный размер обеих сторон
```typescript
public totalSize(): Quantity
```

**`bestSide()`** - какая сторона лучше заполнена
```typescript
public bestSide(): 'bid' | 'ask' | 'balanced'
```

---

#### 2.2 Comparison методы

**`isBetterThan(other)`** - сравнение качества котировок
```typescript
public isBetterThan(other: Quote): boolean
```
**Критерии:** tighter spread, larger size, fresher timestamp

**`isTighterThan(other)`** - сравнение только spread
```typescript
public isTighterThan(other: Quote): boolean
```

**`hasMoreLiquidity(other)`** - сравнение только размеров
```typescript
public hasMoreLiquidity(other: Quote): boolean
```

---

#### 2.3 Predicates

**`isBalanced(threshold)`** - проверка баланса размеров
```typescript
public isBalanced(threshold: Decimal): boolean
```
```typescript
// Считается balanced если |imbalance| < threshold
const balanced = quote.isBalanced(new Decimal(0.1)); // ±10%
```

**`isTight(maxSpread)`** - проверка что spread узкий
```typescript
public isTight(maxSpread: Decimal): boolean
```

**`hasLiquidity(minSize)`** - проверка минимальной ликвидности
```typescript
public hasLiquidity(minSize: Quantity): boolean
```

---

### 3. Rules - новые правила

#### 3.1 Валидация качества

**`ValidateSpreadPercentage`** - процентный spread в пределах
```typescript
export class ValidateSpreadPercentage {
  check(
    quote: Quote,
    maxPercentage: Decimal
  ): Result<void, InvalidQuoteError>
}
```
**Use case:** Spread не должен превышать 10% от mid

**`ValidateImbalance`** - дисбаланс в пределах
```typescript
export class ValidateImbalance {
  check(
    quote: Quote,
    maxImbalance: Decimal
  ): Result<void, InvalidQuoteError>
}
```
**Use case:** Размеры не должны сильно различаться

**`ValidateAge`** - свежесть котировки
```typescript
export class ValidateAge {
  check(
    quote: Quote,
    maxAgeMs: number
  ): Result<void, InvalidQuoteError>
}
```
**Use case:** Котировка не старше N секунд

---

#### 3.2 Бизнес-правила

**`ValidateTickAlignment`** - выравнивание по tick size
```typescript
export class ValidateTickAlignment {
  check(
    quote: Quote,
    tickSize: Decimal
  ): Result<void, InvalidQuoteError>
}
```
**Use case:** Цены кратны tick size биржи

**`ValidatePriceRange`** - цены в допустимом диапазоне
```typescript
export class ValidatePriceRange {
  check(
    quote: Quote,
    minPrice: Price,
    maxPrice: Price
  ): Result<void, InvalidQuoteError>
}
```
**Use case:** Проверка разумности цен

**`ValidateSizeRatio`** - соотношение размеров
```typescript
export class ValidateSizeRatio {
  check(
    quote: Quote,
    maxRatio: Decimal
  ): Result<void, InvalidQuoteError>
}
```
**Use case:** bidSize/askSize не должен превышать N:1

---

### 4. Adapters - новые возможности

#### 4.1 QuoteFormatter расширения

**`formatCompact()`** - компактный формат
```typescript
formatCompact(quote: Quote): string
// "0.48/0.52 @100x150"
```

**`formatWithSpread()`** - с информацией о spread
```typescript
formatWithSpread(quote: Quote): string
// "0.48-0.52 (4bp, mid=0.50)"
```

**`formatForDisplay()`** - для UI с Unicode
```typescript
formatForDisplay(quote: Quote): string
// "Bid: $0.48 ↔ Ask: $0.52 • Spread: 4.0%"
```

**`formatWithAge()`** - с возрастом котировки
```typescript
formatWithAge(quote: Quote): string
// "0.48/0.52 (2.3s ago)"
```

---

#### 4.2 QuoteSerializer расширения

**`toCSV()`** - CSV формат для экспорта
```typescript
toCSV(quote: Quote): string
// "1234567890,0.48,0.52,100,150"
```

**`toFixMessage()`** - FIX protocol формат
```typescript
toFixMessage(quote: Quote): string
// "132=0.48|133=100|134=0.52|135=150|..."
```

**`fromMarketData(data)`** - из биржевых данных
```typescript
static fromMarketData(
  data: MarketDataSnapshot
): Result<Quote, InvalidQuoteError>
```

---

## 📊 Приоритизация

### High Priority (Must Have)
1. ✅ **widenSpread()** / **narrowSpread()** - очень частые операции
2. ✅ **scaleSize()** - управление ликвидностью
3. ✅ **roundToTickSize()** - критично для compliance
4. ✅ **isStale()** - проверка актуальности
5. ✅ **spreadPercentage()** - часто нужна метрика
6. ✅ **ValidateAge** - критичная валидация

### Medium Priority (Should Have)
7. **improveBid()** / **improveAsk()** - улучшение цен
8. **merge()** - агрегация источников
9. **flip()** - для двусторонних рынков
10. **imbalance()** - анализ баланса
11. **ValidateSpreadPercentage** - контроль spread
12. **formatCompact()** - удобный вывод

### Low Priority (Nice to Have)
13. worsenBid() / worsenAsk() - редко нужны
14. weightedMerge() - сложная агрегация
15. qualityScore() - субъективная метрика
16. effectiveSpread() - продвинутая аналитика
17. toFixMessage() - специфичный формат

---

## 🎯 Рекомендация по реализации

**Начать с Top 6 (High Priority):**

1. **QuoteService:**
   - widenSpread()
   - narrowSpread()
   - scaleSize()
   - roundToTickSize()
   - isStale()

2. **Quote Core:**
   - spreadPercentage()

3. **Rules:**
   - ValidateAge

Эти методы покроют 80% практических use cases и создадут solid foundation для дальнейшего расширения.

**Следующая итерация (Medium Priority):**
- Операции улучшения цен (improve*)
- Объединение котировок (merge)
- Метрики анализа (imbalance)

---

## 💡 Дополнительные соображения

### Naming Conventions
- **improve/worsen** - для направленных изменений цен
- **widen/narrow** - для spread операций
- **scale/set** - для размеров
- **round/align** - для нормализации
- **is/has** - для predicates
- **get** - для query (или без префикса)
- **Validate** - для Rules

### Паттерны использования
```typescript
// Типичный workflow market maker
const quote = QuoteService.create(0.48, 0.52, 100, 150);
const rounded = QuoteService.roundToTickSize(quote, 0.01);
const widened = QuoteService.widenSpread(rounded, 0.01);
const scaled = QuoteService.scaleSize(widened, 2);

// Проверка перед отправкой
if (!QuoteService.isStale(scaled, 5000)) {
  sendToExchange(scaled);
}
```

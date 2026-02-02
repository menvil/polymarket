# Adapters Layer — PercentageSerializer и PercentageFormatter

> Сериализация, десериализация и форматирование

## Обзор

Adapters Layer отвечает за:

- **Сериализацию** — преобразование Percentage в JSON
- **Десериализацию** — валидация JSON и создание Percentage
- **Форматирование** — представление для UI и логов

**Ключевые принципы:**

- **Граница системы** — валидация unknown типов
- **Делегирование** — использует PercentageService для бизнес-валидации
- **Читаемость** — safeStringify для безопасной диагностики

---

## PercentageSerializer

Отвечает за сериализацию и десериализацию Percentage в/из JSON.

### `toJSON(pct: Percentage)`

Сериализует Percentage в plain object.

**Сигнатура:**

```typescript
toJSON(pct: Percentage): { value: string }
```

**Формат:**

```json
{
  "value": "50"
}
```

**Почему value — string:**

- ✅ Избегает потери точности (Decimal → JSON → Decimal)
- ✅ Поддерживает очень большие и очень малые числа
- ✅ Совместимо с Decimal.js

**Примеры:**

```typescript
import { Percentage, PercentageSerializer } from '@polymarket/value-objects/percentage';

const pct = Percentage.of(50);
const json = PercentageSerializer.toJSON(pct);
console.log(json);  // { value: "50" }

// Можно сериализовать в JSON строку
const jsonString = JSON.stringify(json);
console.log(jsonString);  // '{"value":"50"}'

const pct2 = Percentage.of(50.5);
const json2 = PercentageSerializer.toJSON(pct2);
console.log(json2);  // { value: "50.5" }

const pct3 = Percentage.of(-25);
const json3 = PercentageSerializer.toJSON(pct3);
console.log(json3);  // { value: "-25" }
```

---

### `fromJSON(json: unknown)`

Десериализует Percentage из JSON с валидацией.

**Сигнатура:**

```typescript
fromJSON(json: unknown): Result<Percentage, InvalidPercentageError>
```

**Валидация (на границе системы):**

1. Проверка что json — объект (не null, array, primitive)
2. Проверка наличия обязательного поля `value`
3. Проверка типа поля `value` (number или string)
4. Делегирование `PercentageService.create` для бизнес-валидации

**Примеры:**

```typescript
// ✅ Валидные примеры
const result1 = PercentageSerializer.fromJSON({ value: 50 });
if (result1.ok) {
  console.log(result1.value.toNumber());  // 50
}

const result2 = PercentageSerializer.fromJSON({ value: "50.5" });
if (result2.ok) {
  console.log(result2.value.toNumber());  // 50.5
}

const result3 = PercentageSerializer.fromJSON({ value: 0 });
if (result3.ok) {
  console.log(result3.value.isZero());  // true
}

// ❌ Невалидные примеры

// Не объект
const invalidResult1 = PercentageSerializer.fromJSON(null);
if (!invalidResult1.ok) {
  console.log(invalidResult1.error.message);  // "Expected object, got object"
  console.log(invalidResult1.error.context?.reason);  // 'INVALID_FORMAT'
}

const invalidResult2 = PercentageSerializer.fromJSON("50");
if (!invalidResult2.ok) {
  console.log(invalidResult2.error.message);  // "Expected object, got string"
}

const invalidResult3 = PercentageSerializer.fromJSON([50]);
if (!invalidResult3.ok) {
  console.log(invalidResult3.error.message);  // "Expected object, got object"
}

// Отсутствует поле value
const invalidResult4 = PercentageSerializer.fromJSON({ val: 50 });
if (!invalidResult4.ok) {
  console.log(invalidResult4.error.message);  // "Missing required field 'value'"
}

// Невалидный тип value
const invalidResult5 = PercentageSerializer.fromJSON({ value: null });
if (!invalidResult5.ok) {
  console.log(invalidResult5.error.message);  // "Field 'value' must be number or string"
}

const invalidResult6 = PercentageSerializer.fromJSON({ value: true });
if (!invalidResult6.ok) {
  console.log(invalidResult6.error.message);  // "Field 'value' must be number or string"
}

const invalidResult7 = PercentageSerializer.fromJSON({ value: {} });
if (!invalidResult7.ok) {
  console.log(invalidResult7.error.message);  // "Field 'value' must be number or string"
}

// Невалидное значение (бизнес-валидация делегирована PercentageService)
const invalidResult8 = PercentageSerializer.fromJSON({ value: 2000000 });
if (!invalidResult8.ok) {
  console.log(invalidResult8.error.context?.reason);  // 'OUT_OF_RANGE_HIGH'
}
```

---

### Round-trip (туда и обратно)

```typescript
const original = Percentage.of(50.5);

// Serialize
const json = PercentageSerializer.toJSON(original);
console.log(json);  // { value: "50.5" }

// Deserialize
const result = PercentageSerializer.fromJSON(json);
if (result.ok) {
  const restored = result.value;
  console.log(original.equals(restored));  // true
}

// JSON string round-trip
const jsonString = JSON.stringify(json);
const parsed = JSON.parse(jsonString);
const result2 = PercentageSerializer.fromJSON(parsed);
if (result2.ok) {
  console.log(original.equals(result2.value));  // true
}
```

---

### API Integration

```typescript
// Отправка на сервер
async function saveFeeToAPI(fee: Percentage): Promise<void> {
  const payload = PercentageSerializer.toJSON(fee);
  await fetch('/api/fees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// Получение с сервера
async function loadFeeFromAPI(): Promise<Result<Percentage, InvalidPercentageError>> {
  const response = await fetch('/api/fees/current');
  const json = await response.json();  // unknown

  // Валидация на границе
  return PercentageSerializer.fromJSON(json);
}
```

---

## PercentageFormatter

Отвечает за форматирование Percentage для UI и логов.

### `toFixed(pct: Percentage, decimals?: number)`

Форматирует с фиксированным количеством десятичных знаков.

**Сигнатура:**

```typescript
toFixed(pct: Percentage, decimals: number = 2): string
```

**Примеры:**

```typescript
import { Percentage, PercentageFormatter } from '@polymarket/value-objects/percentage';

const pct = Percentage.of(50.5);

console.log(PercentageFormatter.toFixed(pct));      // "50.50"
console.log(PercentageFormatter.toFixed(pct, 0));   // "51"
console.log(PercentageFormatter.toFixed(pct, 4));   // "50.5000"

const pct2 = Percentage.of(99.9999);
console.log(PercentageFormatter.toFixed(pct2));     // "100.00"
console.log(PercentageFormatter.toFixed(pct2, 2));  // "100.00"

const pct3 = Percentage.of(-25.75);
console.log(PercentageFormatter.toFixed(pct3));     // "-25.75"
```

**Throws:**

```typescript
// ❌ Throws RangeError
PercentageFormatter.toFixed(pct, -1);  // "decimals must be non-negative integer"
PercentageFormatter.toFixed(pct, 1.5); // "decimals must be non-negative integer"
```

---

### `toPercent(pct: Percentage, decimals?: number)`

Форматирует с символом процента.

**Сигнатура:**

```typescript
toPercent(pct: Percentage, decimals: number = 2): string
```

**Примеры:**

```typescript
const pct = Percentage.of(50.5);

console.log(PercentageFormatter.toPercent(pct));              // "50.50%"
console.log(PercentageFormatter.toPercent(pct, 0));           // "51%"
console.log(PercentageFormatter.toPercent(pct, 4));           // "50.5000%"

const pct2 = Percentage.of(-10.25);
console.log(PercentageFormatter.toPercent(pct2));             // "-10.25%"

const pct3 = Percentage.of(0.01);
console.log(PercentageFormatter.toPercent(pct3, 4));          // "0.0100%"

const pct4 = Percentage.of(250);
console.log(PercentageFormatter.toPercent(pct4));             // "250.00%"
```

**Когда использовать:** UI display, user-facing текст.

---

### `toDecimalFraction(pct: Percentage, decimals?: number)`

Форматирует как десятичную дробь (шкала 0-1).

**Сигнатура:**

```typescript
toDecimalFraction(pct: Percentage, decimals: number = 4): string
```

**Примеры:**

```typescript
const pct = Percentage.of(50);

console.log(PercentageFormatter.toDecimalFraction(pct));      // "0.5000"
console.log(PercentageFormatter.toDecimalFraction(pct, 2));   // "0.50"

const pct2 = Percentage.of(25);
console.log(PercentageFormatter.toDecimalFraction(pct2));     // "0.2500"

const pct3 = Percentage.of(0.01);
console.log(PercentageFormatter.toDecimalFraction(pct3, 6));  // "0.000100"

const pct4 = Percentage.of(150);
console.log(PercentageFormatter.toDecimalFraction(pct4));     // "1.5000"
```

**Когда использовать:** API integration, математические расчёты, JSON export.

---

### `toBasisPoints(pct: Percentage, decimals?: number)`

Форматирует как базисные пункты с единицами.

**Сигнатура:**

```typescript
toBasisPoints(pct: Percentage, decimals: number = 0): string
```

**Примеры:**

```typescript
const pct = Percentage.of(50);

console.log(PercentageFormatter.toBasisPoints(pct));          // "5000 bp"

const pct2 = Percentage.of(0.01);
console.log(PercentageFormatter.toBasisPoints(pct2));         // "1 bp"

const pct3 = Percentage.of(2.5);
console.log(PercentageFormatter.toBasisPoints(pct3));         // "250 bp"
console.log(PercentageFormatter.toBasisPoints(pct3, 2));      // "250.00 bp"

const pct4 = Percentage.of(0.005);
console.log(PercentageFormatter.toBasisPoints(pct4, 1));      // "0.5 bp"
```

**Когда использовать:** Финансовые отчёты, логи, где важна точность малых процентов.

---

### `toCompact(pct: Percentage, decimals?: number)`

Компактное форматирование с символом процента.

**Сигнатура:**

```typescript
toCompact(pct: Percentage, decimals: number = 1): string
```

**Примеры:**

```typescript
const pct1 = Percentage.of(50.5);
console.log(PercentageFormatter.toCompact(pct1));             // "50.5%"

const pct2 = Percentage.of(-10.25);
console.log(PercentageFormatter.toCompact(pct2));             // "-10.3%"

const pct3 = Percentage.of(0.01);
console.log(PercentageFormatter.toCompact(pct3));             // "0.0%"
console.log(PercentageFormatter.toCompact(pct3, 4));          // "0.0100%"

const pct4 = Percentage.of(99.9999);
console.log(PercentageFormatter.toCompact(pct4));             // "100.0%"
```

**Когда использовать:** Ограниченное пространство (mobile UI, tooltips).

---

## Use Cases

### UI Display

```typescript
function renderFeeDisplay(fee: Percentage): string {
  // Для пользователя: "2.50%"
  return PercentageFormatter.toPercent(fee);
}

function renderCompactFee(fee: Percentage): string {
  // Для малого экрана: "2.5%"
  return PercentageFormatter.toCompact(fee);
}

function renderPreciseFee(fee: Percentage): string {
  // Для детального отображения: "2.5000%"
  return PercentageFormatter.toPercent(fee, 4);
}
```

---

### API Integration

```typescript
// Отправка в API (decimal fraction format)
async function sendFeeToAPI(fee: Percentage) {
  const payload = {
    fee: PercentageFormatter.toDecimalFraction(fee, 6)  // "0.025000"
  };

  await fetch('/api/config', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

// Получение из API
async function receiveFeeFromAPI(): Promise<Result<Percentage, InvalidPercentageError>> {
  const response = await fetch('/api/config');
  const data = await response.json();

  // data.fee может быть "0.025" или "2.5" в зависимости от API
  // Используем PercentageSerializer для валидации
  return PercentageSerializer.fromJSON({ value: data.fee });
}
```

---

### Logging

```typescript
function logFeeUpdate(oldFee: Percentage, newFee: Percentage): void {
  console.log(`Fee updated from ${PercentageFormatter.toPercent(oldFee)} to ${PercentageFormatter.toPercent(newFee)}`);
  // "Fee updated from 2.00% to 2.50%"

  console.log(`In basis points: ${PercentageFormatter.toBasisPoints(oldFee)} → ${PercentageFormatter.toBasisPoints(newFee)}`);
  // "In basis points: 200 bp → 250 bp"
}

function logSpreadAnalysis(spread: Percentage): void {
  console.log('Spread Analysis:');
  console.log(`  Percentage: ${PercentageFormatter.toPercent(spread, 4)}`);
  console.log(`  Decimal: ${PercentageFormatter.toDecimalFraction(spread, 6)}`);
  console.log(`  Basis Points: ${PercentageFormatter.toBasisPoints(spread, 2)}`);

  // Spread Analysis:
  //   Percentage: 0.5000%
  //   Decimal: 0.005000
  //   Basis Points: 50.00 bp
}
```

---

### Reports

```typescript
function generateFeeReport(fees: { maker: Percentage; taker: Percentage; total: Percentage }) {
  return `
Fee Structure Report
====================
Maker Fee:  ${PercentageFormatter.toPercent(fees.maker, 2).padStart(8)}  (${PercentageFormatter.toBasisPoints(fees.maker)} bp)
Taker Fee:  ${PercentageFormatter.toPercent(fees.taker, 2).padStart(8)}  (${PercentageFormatter.toBasisPoints(fees.taker)} bp)
Total Fee:  ${PercentageFormatter.toPercent(fees.total, 2).padStart(8)}  (${PercentageFormatter.toBasisPoints(fees.total)} bp)
  `.trim();
}

// Fee Structure Report
// ====================
// Maker Fee:    2.00%  (200 bp)
// Taker Fee:    3.00%  (300 bp)
// Total Fee:    5.00%  (500 bp)
```

---

## Best Practices

### ✅ DO: Используйте правильный formatter для контекста

```typescript
// ✅ Хорошо
const userDisplay = PercentageFormatter.toPercent(fee);           // UI
const apiPayload = PercentageFormatter.toDecimalFraction(fee, 6); // API
const logMessage = PercentageFormatter.toBasisPoints(fee);        // Logs
const mobile = PercentageFormatter.toCompact(fee);                // Mobile
```

### ❌ DON'T: Не форматируйте вручную

```typescript
// ❌ Плохо (может потерять точность)
const display = fee.toNumber() + '%';
const decimal = fee.toNumber() / 100;
```

---

### ✅ DO: Валидируйте JSON на границе

```typescript
// ✅ Хорошо
const result = PercentageSerializer.fromJSON(untrustedData);
if (!result.ok) {
  console.error('Invalid percentage data:', result.error.context);
  return;
}
const pct = result.value;
```

### ❌ DON'T: Не доверяйте unknown данным

```typescript
// ❌ Плохо (нет валидации)
const pct = Percentage.of(untrustedData.value);  // Может кинуть исключение!
```

---

### ✅ DO: Используйте string в JSON

```typescript
// ✅ Хорошо (точность)
PercentageSerializer.toJSON(pct);  // { value: "50.5" }
```

### ❌ DON'T: Не используйте number

```typescript
// ❌ Плохо (потеря точности для больших чисел)
{ value: pct.toNumber() }  // может потерять точность
```

---

### ✅ DO: Обрабатывайте ошибки fromJSON

```typescript
// ✅ Хорошо
const result = PercentageSerializer.fromJSON(data);
if (!result.ok) {
  switch (result.error.context?.reason) {
    case 'INVALID_FORMAT':
      return handleFormatError(result.error);
    case 'OUT_OF_RANGE_HIGH':
      return handleRangeError(result.error);
  }
}
```

---

## Заключение

Adapters Layer для Percentage обеспечивает:

1. **Безопасную сериализацию** — toJSON/fromJSON с валидацией
2. **Гибкое форматирование** — toPercent, toDecimalFraction, toBasisPoints, toCompact
3. **Граничную валидацию** — fromJSON проверяет структуру на границе системы
4. **Читаемость** — форматирование для UI, логов, отчётов
5. **Type safety** — Result<T, E> для десериализации

Используйте PercentageSerializer для границ системы и PercentageFormatter для представления!

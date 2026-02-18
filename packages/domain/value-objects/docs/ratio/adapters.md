# Ratio Adapters API Reference

Детальная документация RatioFormatter и RatioSerializer.

## Содержание

- [Обзор](#обзор)
- [RatioFormatter](#ratioformatter)
  - [toDecimal()](#todecimal)
  - [toPercent()](#topercent)
  - [toBps()](#tobps)
  - [parse()](#parse)
- [RatioSerializer](#ratioserializer)
  - [toJSON()](#tojson)
  - [fromJSON()](#fromjson)
- [Error Handling](#error-handling)
- [Best Practices](#best-practices)

## Обзор

**Adapters слой** предоставляет функциональность для форматирования и сериализации Ratio:

- **RatioFormatter** - преобразование Ratio в/из строк (decimal, percent, bps)
- **RatioSerializer** - сериализация Ratio в/из JSON

**Общие характеристики:**

- ✅ Большинство методов возвращают `Result<T, E>` (Never Throw Contract)
- ✅ Типизированные ошибки через `InvalidRatioError`
- ✅ Inline валидация параметров
- ✅ Используют RatioService для создания Ratio
- ⚠️ `toJSON()` является инфаллибильным и возвращает `RatioJSON` напрямую

**Import:**

```typescript
import {
  RatioFormatter,
  RatioSerializer
} from '@polymarket/value-objects/ratio';
```

## RatioFormatter

Форматирование Ratio в строки различных форматов.

### `toDecimal()`

```typescript
public static toDecimal(
  ratio: Ratio,
  decimals: number = 4
): Result<string, InvalidRatioError>
```

**Описание:**
Форматировать Ratio как decimal string.

**Параметры:**

- `ratio: Ratio` - Ratio для форматирования
- `decimals: number = 4` - Количество десятичных знаков (по умолчанию 4)

**Возвращает:**

- `Ok(string)` - отформатированная строка (например, `"0.0200"`)
- `Err(InvalidRatioError)` - если `decimals` невалиден

**Примеры:**

#### Базовое использование

```typescript
import { RatioService, RatioFormatter } from '@polymarket/value-objects';

const ratioResult = RatioService.fromPercent(2);
if (ratioResult.ok) {
  const ratio = ratioResult.value;

  // По умолчанию 4 знака
  const formatted = RatioFormatter.toDecimal(ratio);
  console.log(formatted.value); // "0.0200"

  // Кастомное количество знаков
  const formatted2 = RatioFormatter.toDecimal(ratio, 2);
  console.log(formatted2.value); // "0.02"

  const formatted3 = RatioFormatter.toDecimal(ratio, 6);
  console.log(formatted3.value); // "0.020000"
}
```

#### Различные precision

```typescript
const ratioResult = RatioService.fromPercent(2.5);
if (ratioResult.ok) {
  const ratio = ratioResult.value;

  RatioFormatter.toDecimal(ratio, 0); // Ok("0")
  RatioFormatter.toDecimal(ratio, 1); // Ok("0.0")
  RatioFormatter.toDecimal(ratio, 2); // Ok("0.03")
  RatioFormatter.toDecimal(ratio, 3); // Ok("0.025")
  RatioFormatter.toDecimal(ratio, 4); // Ok("0.0250")
}
```

#### Валидация decimals

```typescript
// ❌ Отрицательный decimals
const invalid1 = RatioFormatter.toDecimal(ratio, -1);
if (!invalid1.ok) {
  console.error(invalid1.error.context?.reason); // INVALID_DECIMALS
}

// ❌ Дробный decimals
const invalid2 = RatioFormatter.toDecimal(ratio, 2.5);
if (!invalid2.ok) {
  console.error(invalid2.error.context?.reason); // INVALID_DECIMALS
}
```

**Когда использовать:**

- Отображение в UI (raw value)
- Логирование
- API responses (если формат decimal)
- Debug output

### `toPercent()`

```typescript
public static toPercent(
  ratio: Ratio,
  decimals: number = 2
): Result<string, InvalidRatioError>
```

**Описание:**
Форматировать Ratio как процент (с символом `%`).

**Параметры:**

- `ratio: Ratio` - Ratio для форматирования
- `decimals: number = 2` - Количество десятичных знаков (по умолчанию 2)

**Возвращает:**

- `Ok(string)` - отформатированная строка (например, `"2.50%"`)
- `Err(InvalidRatioError)` - если `decimals` невалиден

**Конверсия:**

```typescript
ratio (fraction) → percent = ratio * 100

0.02 → "2.00%"
0.5 → "50.00%"
1.0 → "100.00%"
-0.2 → "-20.00%"
```

**Примеры:**

#### Базовое использование

```typescript
const ratioResult = RatioService.fromPercent(2.5);
if (ratioResult.ok) {
  const ratio = ratioResult.value;

  // По умолчанию 2 знака
  const formatted = RatioFormatter.toPercent(ratio);
  console.log(formatted.value); // "2.50%"

  // 1 знак
  const formatted1 = RatioFormatter.toPercent(ratio, 1);
  console.log(formatted1.value); // "2.5%"

  // 0 знаков
  const formatted0 = RatioFormatter.toPercent(ratio, 0);
  console.log(formatted0.value); // "3%"
}
```

#### Различные величины

```typescript
// Малый процент
const small = RatioService.fromPercent(0.5);
if (small.ok) {
  RatioFormatter.toPercent(small.value, 2); // "0.50%"
}

// Большой процент
const large = RatioService.fromPercent(150);
if (large.ok) {
  RatioFormatter.toPercent(large.value, 0); // "150%"
}

// Отрицательный процент
const negative = RatioService.fromPercent(-20);
if (negative.ok) {
  RatioFormatter.toPercent(negative.value, 1); // "-20.0%"
}

// Нулевой
RatioFormatter.toPercent(Ratio.ZERO, 0); // "0%"
```

#### Для UI display

```typescript
function formatChangePercent(ratio: Ratio): string {
  const result = RatioFormatter.toPercent(ratio, 2);

  if (!result.ok) {
    return 'N/A';
  }

  const formatted = result.value;
  const emoji = ratio.isPositive() ? '📈' : ratio.isNegative() ? '📉' : '➡️';

  return `${emoji} ${formatted}`;
}

const changeResult = RatioService.fromPercent(5.25);
if (changeResult.ok) {
  console.log(formatChangePercent(changeResult.value)); // "📈 5.25%"
}
```

**Когда использовать:**

- ✅ UI отображение процентов
- ✅ Reports и dashboards
- ✅ User-facing output
- ✅ Notifications/alerts

### `toBps()`

```typescript
public static toBps(
  ratio: Ratio,
  decimals: number = 0
): Result<string, InvalidRatioError>
```

**Описание:**
Форматировать Ratio как basis points (с суффиксом `bps`).

**Параметры:**

- `ratio: Ratio` - Ratio для форматирования
- `decimals: number = 0` - Количество десятичных знаков (по умолчанию 0)

**Возвращает:**

- `Ok(string)` - отформатированная строка (например, `"200 bps"`)
- `Err(InvalidRatioError)` - если `decimals` невалиден

**Конверсия:**

```typescript
ratio (fraction) → bps = ratio * 10000

0.02 → "200 bps"
0.0001 → "1 bps"
0.5 → "5000 bps"
1.0 → "10000 bps"
```

**Справка:** 1 basis point = 0.01% = 0.0001 (fraction)

**Примеры:**

#### Базовое использование

```typescript
const ratioResult = RatioService.fromPercent(2.5);
if (ratioResult.ok) {
  const ratio = ratioResult.value;

  // По умолчанию 0 знаков
  const formatted = RatioFormatter.toBps(ratio);
  console.log(formatted.value); // "250 bps"

  // С дробной частью
  const formatted1 = RatioFormatter.toBps(ratio, 1);
  console.log(formatted1.value); // "250.0 bps"
}
```

#### Финансовые rates

```typescript
// Spread 50 bps
const spreadResult = RatioService.fromBps(50);
if (spreadResult.ok) {
  const formatted = RatioFormatter.toBps(spreadResult.value, 0);
  console.log(formatted.value); // "50 bps"
}

// Yield 3.25%
const yieldResult = RatioService.fromPercent(3.25);
if (yieldResult.ok) {
  const formatted = RatioFormatter.toBps(yieldResult.value, 0);
  console.log(formatted.value); // "325 bps"
}

// Очень малый spread (0.5 bps)
const tinyResult = RatioService.fromBps(0.5);
if (tinyResult.ok) {
  const formatted = RatioFormatter.toBps(tinyResult.value, 1);
  console.log(formatted.value); // "0.5 bps"
}
```

#### Отрицательные bps

```typescript
const negativeResult = RatioService.fromBps(-25);
if (negativeResult.ok) {
  const formatted = RatioFormatter.toBps(negativeResult.value, 0);
  console.log(formatted.value); // "-25 bps"
}
```

**Когда использовать:**

- ✅ Финансовые инструменты (bonds, rates, spreads)
- ✅ Trading dashboards
- ✅ Interest rates
- ✅ Yield calculations
- ✅ Малые изменения (<1%)

### `parse()`

```typescript
public static parse(input: string): Result<Ratio, InvalidRatioError>
```

**Описание:**
Парсинг строки в Ratio. Автоматически определяет формат.

**Поддерживаемые форматы:**

- `"0.02"` - decimal (дробь)
- `"2%"` - percent (процент)
- `"200 bps"` - basis points

**Параметры:**

- `input: string` - Строка для парсинга

**Возвращает:**

- `Ok(Ratio)` - успешно распарсенный Ratio
- `Err(InvalidRatioError)` - если формат невалиден

**Примеры:**

#### Decimal формат

```typescript
const result1 = RatioFormatter.parse("0.02");
if (result1.ok) {
  console.log(result1.value.toDecimal().toString()); // "0.02"
}

const result2 = RatioFormatter.parse("0.5");
if (result2.ok) {
  console.log(result2.value.toDecimal().toString()); // "0.5"
}

const result3 = RatioFormatter.parse("-0.2");
if (result3.ok) {
  console.log(result3.value.toDecimal().toString()); // "-0.2"
}
```

#### Percent формат

```typescript
const result1 = RatioFormatter.parse("2%");
if (result1.ok) {
  console.log(result1.value.toDecimal().toString()); // "0.02"
}

const result2 = RatioFormatter.parse("50%");
if (result2.ok) {
  console.log(result2.value.toDecimal().toString()); // "0.5"
}

const result3 = RatioFormatter.parse("-20%");
if (result3.ok) {
  console.log(result3.value.toDecimal().toString()); // "-0.2"
}
```

#### Basis points формат

```typescript
const result1 = RatioFormatter.parse("200 bps");
if (result1.ok) {
  console.log(result1.value.toDecimal().toString()); // "0.02"
}

const result2 = RatioFormatter.parse("50 bps");
if (result2.ok) {
  console.log(result2.value.toDecimal().toString()); // "0.005"
}

const result3 = RatioFormatter.parse("1bps"); // без пробела - тоже работает
if (result3.ok) {
  console.log(result3.value.toDecimal().toString()); // "0.0001"
}
```

#### Round-trip

```typescript
// Decimal
const original1 = RatioService.fromPercent(2.5);
if (original1.ok) {
  const formatted = RatioFormatter.toDecimal(original1.value, 4);
  if (formatted.ok) {
    const parsed = RatioFormatter.parse(formatted.value);
    if (parsed.ok) {
      console.log(original1.value.equals(parsed.value)); // true
    }
  }
}

// Percent
const original2 = RatioService.fromPercent(2.5);
if (original2.ok) {
  const formatted = RatioFormatter.toPercent(original2.value, 1);
  if (formatted.ok) {
    const parsed = RatioFormatter.parse(formatted.value); // "2.5%"
    if (parsed.ok) {
      console.log(original2.value.equals(parsed.value)); // true
    }
  }
}

// Bps
const original3 = RatioService.fromBps(250);
if (original3.ok) {
  const formatted = RatioFormatter.toBps(original3.value, 0);
  if (formatted.ok) {
    const parsed = RatioFormatter.parse(formatted.value); // "250 bps"
    if (parsed.ok) {
      console.log(original3.value.equals(parsed.value)); // true
    }
  }
}
```

#### Обработка невалидного ввода

```typescript
// Невалидный формат
const invalid1 = RatioFormatter.parse("not-a-number");
if (!invalid1.ok) {
  console.error(invalid1.error.context?.reason); // INVALID_FORMAT
}

// Пустая строка
const invalid2 = RatioFormatter.parse("");
if (!invalid2.ok) {
  console.error(invalid2.error.context?.reason); // INVALID_FORMAT
}

// Некорректный percent
const invalid3 = RatioFormatter.parse("abc%");
if (!invalid3.ok) {
  console.error(invalid3.error.context?.reason); // INVALID_FORMAT
}
```

#### User input parsing

```typescript
function parseUserInput(input: string): Ratio | null {
  const result = RatioFormatter.parse(input.trim());

  if (result.ok) {
    return result.value;
  } else {
    console.error('Invalid input:', input);
    console.error('Error:', result.error.message);
    return null;
  }
}

// Examples
parseUserInput("2%");      // Ratio(0.02)
parseUserInput("0.02");    // Ratio(0.02)
parseUserInput("200 bps"); // Ratio(0.02)
parseUserInput("invalid"); // null
```

**Когда использовать:**

- ✅ Парсинг пользовательского ввода
- ✅ Чтение из конфигурационных файлов
- ✅ Импорт данных из CSV/text
- ✅ API responses (если формат string)

## RatioSerializer

Сериализация Ratio в/из JSON с сохранением точности.

### JSON Формат

```typescript
interface RatioJSON {
  ratio: string; // decimal string для точности
}
```

**Пример:**

```json
{
  "ratio": "0.02"
}
```

**Почему decimal string:**

- ✅ Сохраняет точность (Decimal.js precision)
- ✅ Избегает lossy conversion через JSON number
- ✅ Работает с очень большими/малыми числами

### `toJSON()`

```typescript
public static toJSON(ratio: Ratio): RatioJSON
```

**Описание:**
Сериализовать Ratio в JSON объект.

**Параметры:**

- `ratio: Ratio` - Ratio для сериализации

**Возвращает:**

- `RatioJSON` - JSON объект с полем `ratio` (decimal string)

**Примеры:**

#### Базовое использование

```typescript
import { RatioService, RatioSerializer } from '@polymarket/value-objects';

const ratioResult = RatioService.fromPercent(2);
if (ratioResult.ok) {
  const json = RatioSerializer.toJSON(ratioResult.value);
  console.log(json); // { ratio: "0.02" }
}
```

#### Различные precision

```typescript
// Высокая точность
const preciseResult = RatioService.fromDecimal("0.123456789012345");
if (preciseResult.ok) {
  const json = RatioSerializer.toJSON(preciseResult.value);
  console.log(json); // { ratio: "0.123456789012345" }
  // Точность сохранена!
}

// Очень малое значение
const tinyResult = RatioService.fromBps(1); // 0.0001
if (tinyResult.ok) {
  const json = RatioSerializer.toJSON(tinyResult.value);
  console.log(json); // { ratio: "0.0001" }
}
```

#### Сериализация для API

```typescript
interface TradingConfig {
  makerFee: RatioJSON;
  takerFee: RatioJSON;
  maxSlippage: RatioJSON;
}

function serializeConfig(
  makerFee: Ratio,
  takerFee: Ratio,
  maxSlippage: Ratio
): TradingConfig {
  return {
    makerFee: RatioSerializer.toJSON(makerFee),
    takerFee: RatioSerializer.toJSON(takerFee),
    maxSlippage: RatioSerializer.toJSON(maxSlippage)
  };
}

// Usage
const makerResult = RatioService.fromPercent(0.1);
const takerResult = RatioService.fromPercent(0.2);
const slippageResult = RatioService.fromBps(50);

if (makerResult.ok && takerResult.ok && slippageResult.ok) {
  const config = serializeConfig(
    makerResult.value,
    takerResult.value,
    slippageResult.value
  );

  console.log(JSON.stringify(config, null, 2));
  // {
  //   "makerFee": { "ratio": "0.001" },
  //   "takerFee": { "ratio": "0.002" },
  //   "maxSlippage": { "ratio": "0.005" }
  // }
}
```

### `fromJSON()`

```typescript
public static fromJSON(json: unknown): Result<Ratio, InvalidRatioError>
```

**Описание:**
Десериализовать Ratio из JSON объекта.

**Параметры:**

- `json: unknown` - JSON объект (type-safe: accepts unknown)

**Возвращает:**

- `Ok(Ratio)` - успешно десериализованный Ratio
- `Err(InvalidRatioError)` - если структура невалидна

**Примеры:**

#### Базовое использование

```typescript
const json = { ratio: "0.02" };
const result = RatioSerializer.fromJSON(json);

if (result.ok) {
  console.log(result.value.toDecimal().toString()); // "0.02"
}
```

#### Round-trip

```typescript
const original = RatioService.fromPercent(2.5);
if (original.ok) {
  // Serialize
  const json = RatioSerializer.toJSON(original.value);
  console.log(json); // { ratio: "0.025" }

  // Deserialize
  const deserialized = RatioSerializer.fromJSON(json);
  if (deserialized.ok) {
    console.log(original.value.equals(deserialized.value)); // true
  }
}
```

#### JSON.stringify → JSON.parse

```typescript
const ratioResult = RatioService.fromPercent(2);
if (ratioResult.ok) {
  // Serialize to JSON string
  const json = RatioSerializer.toJSON(ratioResult.value);
  const jsonString = JSON.stringify(json);
  console.log(jsonString); // '{"ratio":"0.02"}'

  // Parse back
  const parsed = JSON.parse(jsonString);
  const deserialized = RatioSerializer.fromJSON(parsed);

  if (deserialized.ok) {
    console.log(ratioResult.value.equals(deserialized.value)); // true
  }
}
```

#### Валидация структуры

```typescript
// ❌ Не объект
const invalid1 = RatioSerializer.fromJSON("not-an-object");
if (!invalid1.ok) {
  console.error(invalid1.error.context?.reason); // INVALID_JSON_STRUCTURE
}

// ❌ null
const invalid2 = RatioSerializer.fromJSON(null);
if (!invalid2.ok) {
  console.error(invalid2.error.context?.reason); // INVALID_JSON_STRUCTURE
}

// ❌ Нет поля "ratio"
const invalid3 = RatioSerializer.fromJSON({ value: "0.02" });
if (!invalid3.ok) {
  console.error(invalid3.error.context?.reason); // INVALID_JSON_STRUCTURE
}

// ❌ "ratio" не string
const invalid4 = RatioSerializer.fromJSON({ ratio: 0.02 });
if (!invalid4.ok) {
  console.error(invalid4.error.context?.reason); // INVALID_JSON_STRUCTURE
}

// ❌ Невалидное значение
const invalid5 = RatioSerializer.fromJSON({ ratio: "not-a-number" });
if (!invalid5.ok) {
  console.error(invalid5.error.context?.reason); // INVALID_FORMAT
}
```

#### Type-safe API response parsing

```typescript
async function fetchRatioFromApi(url: string): Promise<Result<Ratio, Error>> {
  try {
    const response = await fetch(url);
    const json: unknown = await response.json();

    const result = RatioSerializer.fromJSON(json);

    if (result.ok) {
      return Ok(result.value);
    } else {
      return Err(new Error(`Invalid ratio from API: ${result.error.message}`));
    }
  } catch (error) {
    return Err(new Error(`API fetch failed: ${String(error)}`));
  }
}
```

## Error Handling

### Общий контракт

**Методы с валидацией** (parsing, formatting с параметрами) следуют Never Throw Contract:

```typescript
// ✅ Методы с валидацией возвращают Result, никогда не бросают
const result = RatioFormatter.toPercent(ratio, decimals);

if (result.ok) {
  // Success path
  const formatted = result.value;
} else {
  // Error path
  const error = result.error;
  console.error(error.context?.reason);
}
```

**Инфаллибильные методы** (toJSON) возвращают значение напрямую:

```typescript
// ✅ Инфаллибильные методы не могут упасть, возвращают значение напрямую
const json = RatioSerializer.toJSON(ratio); // RatioJSON
```

### Error Reasons

```typescript
enum RatioErrorReason {
  INVALID_DECIMALS = 'INVALID_DECIMALS',       // decimals < 0 или не integer
  INVALID_FORMAT = 'INVALID_FORMAT',           // невалидная строка при parse
  INVALID_JSON_STRUCTURE = 'INVALID_JSON_STRUCTURE', // невалидная JSON структура
  NAN = 'NAN',                                 // значение NaN
  NON_FINITE = 'NON_FINITE'                    // значение Infinity
}
```

### Error Handling Pattern

```typescript
function formatRatioSafely(ratio: Ratio): string {
  const result = RatioFormatter.toPercent(ratio, 2);

  if (result.ok) {
    return result.value;
  } else {
    // Fallback для UI
    console.error('Format error:', result.error);
    return 'N/A';
  }
}
```

## Best Practices

### 1. Выбирайте правильный формат для контекста

```typescript
// ✅ UI отображение → toPercent()
const uiDisplay = RatioFormatter.toPercent(ratio, 2); // "2.50%"

// ✅ Финансы → toBps()
const financeDisplay = RatioFormatter.toBps(ratio, 0); // "250 bps"

// ✅ API/Debug → toDecimal()
const apiValue = RatioFormatter.toDecimal(ratio, 4); // "0.0250"
```

### 2. Round-trip тестирование

```typescript
// Всегда проверяйте, что format → parse → format дает тот же результат
const original = RatioService.fromPercent(2.5);
if (original.ok) {
  const formatted = RatioFormatter.toPercent(original.value, 2);
  if (formatted.ok) {
    const parsed = RatioFormatter.parse(formatted.value);
    if (parsed.ok) {
      expect(original.value.equals(parsed.value)).toBe(true);
    }
  }
}
```

### 3. JSON serialization для persistence

```typescript
// ✅ Используйте RatioSerializer для хранения
const ratio = RatioService.fromPercent(2.5).value;
const json = RatioSerializer.toJSON(ratio);
saveToDatabase(json); // { ratio: "0.025" }

// ✅ Deserialize при загрузке
const loadedJson = loadFromDatabase();
const loaded = RatioSerializer.fromJSON(loadedJson);
```

### 4. Валидация пользовательского ввода

```typescript
function parseUserRatio(input: string): Result<Ratio, string> {
  const result = RatioFormatter.parse(input);

  if (result.ok) {
    return Ok(result.value);
  } else {
    // User-friendly error message
    return Err('Please enter a valid ratio (e.g., "2%", "0.02", "200 bps")');
  }
}
```

### 5. Consistent precision в UI

```typescript
// ✅ Определите стандарты для вашего приложения
const UI_PERCENT_DECIMALS = 2;
const UI_BPS_DECIMALS = 0;

function formatForUI(ratio: Ratio): string {
  const result = RatioFormatter.toPercent(ratio, UI_PERCENT_DECIMALS);
  return result.ok ? result.value : 'N/A';
}
```

### 6. Type-safe API integration

```typescript
// ✅ Используйте RatioJSON type для API contracts
interface ApiResponse {
  feeRatio: RatioJSON;
  discountRatio: RatioJSON;
}

function parseApiResponse(json: unknown): Result<{ fee: Ratio; discount: Ratio }, Error> {
  // Type-safe parsing
  if (typeof json !== 'object' || json === null) {
    return Err(new Error('Invalid response'));
  }

  const obj = json as Record<string, unknown>;

  const feeResult = RatioSerializer.fromJSON(obj.feeRatio);
  const discountResult = RatioSerializer.fromJSON(obj.discountRatio);

  if (!feeResult.ok || !discountResult.ok) {
    return Err(new Error('Invalid ratios in response'));
  }

  return Ok({
    fee: feeResult.value,
    discount: discountResult.value
  });
}
```

## Следующие шаги

- [Core API Reference](./core.md) - Ratio class методы
- [Facade API Reference](./facade.md) - RatioService factory methods
- [Examples](./examples.md) - примеры использования в реальных сценариях

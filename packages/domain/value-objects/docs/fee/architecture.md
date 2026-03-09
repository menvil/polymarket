# Fee: Архитектура и Дизайн

Детальная документация архитектурных решений и правил валидации Fee Value Object.

## Содержание

- [Обзор архитектуры](#обзор-архитектуры)
- [Слои системы](#слои-системы)
- [Error Reasons](#error-reasons)
- [Правила валидации AssetId](#правила-валидации-assetid)
- [Сравнение с AssetQuantity](#сравнение-с-assetquantity)

## Обзор архитектуры

Fee следует **3-слойной архитектуре** Value Objects в `@polymarket/value-objects`:

```
┌─────────────────────────────────┐
│         Facade Layer            │  FeeService (public API)
│  Result-based для create/add    │  Validates and delegates to core
├─────────────────────────────────┤
│          Core Layer             │  Fee (business logic)
│      Throws on violation        │  Immutable, pure functions
├─────────────────────────────────┤
│        Adapters Layer           │  FeeFormatter, FeeSerializer
│    I/O, formatting, parsing     │  Result-based для deserializers
└─────────────────────────────────┘
```

### Принципы

- **Core Layer (Fee):** Бросает исключения при нарушении инвариантов. Простая бизнес-логика. Immutable операции.
- **Facade Layer (FeeService):** Публичный API с валидацией. Result-based для `create()` и `add()` (Never Throws). `Fee.of()` marked `@internal`.
- **Adapters Layer:** `FeeFormatter` — форматирование для UI/logs. `FeeSerializer` — JSON сериализация (Result-based для deserializers).

## Слои системы

```
fee/
├── core/
│   └── Fee.ts                    # Value object, инварианты, операции
├── errors/
│   ├── FeeErrorReason.ts         # Типизированные причины ошибок (создание)
│   └── FeeOperationErrorReason.ts # Причины ошибок операций (add)
├── facade/
│   └── FeeService.ts             # Публичный API, Result-based
└── adapters/
    ├── FeeFormatter.ts           # UI: display, symbol, debug
    └── FeeSerializer.ts          # JSON: { asset, amount }
```

## Error Reasons

### FeeErrorReason (ошибки валидации при создании)

```typescript
enum FeeErrorReason {
  NEGATIVE_FEE      = 'NEGATIVE_FEE',       // Отрицательная комиссия (не допускается; нулевые комиссии допустимы: amount >= 0)
  INVALID_QUANTITY  = 'INVALID_QUANTITY',   // Невалидный amount (NaN, Infinity)
  INVALID_STRUCTURE = 'INVALID_STRUCTURE',  // Невалидная структура объекта
  INVALID_ASSET     = 'INVALID_ASSET',      // Невалидный AssetId (см. правила ниже)
}
```

### FeeOperationErrorReason (нарушения доменных правил)

```typescript
enum FeeOperationErrorReason {
  ASSET_MISMATCH   = 'ASSET_MISMATCH',    // Попытка сложить fees с разными assets
  UNEXPECTED_ERROR = 'UNEXPECTED_ERROR',  // Неожиданная ошибка в операции
}
```

**Важно:** `FeeService.add()` оборачивает `FeeOperationError` в `Result` и никогда не бросает.
`Fee.add()` (core, напрямую) бросает `FeeOperationError` при asset mismatch.

## Правила валидации AssetId

Правила применяются в `FeeService.create()` и `FeeSerializer.fromJSON()` / `fromUnknown()`.

### CURRENCY asset

- `currency` должна быть поддерживаемой валютой (через `isSupportedCurrency` из `@polymarket/ids`)

### OUTCOME_TOKEN asset — структура

```typescript
{
  type: 'OUTCOME_TOKEN',
  conditionRef: {
    kind: 'ONCHAIN',          // обязательно: только 'ONCHAIN' поддерживается
    protocolId: 'POLYMARKET', // string, [A-Z_][A-Z0-9_]{0,31}
    chainId: 137,             // positive safe integer > 0
    conditionId: '0xabcd...', // '0x' + 64 hex символа (32 байта)
  },
  outcomeKey: 'YES',          // non-empty string, max 32 символа
}
```

#### Поля conditionRef

| Поле | Тип | Правило | Пример ошибки |
|------|-----|---------|---------------|
| `kind` | `string` | Должен быть `'ONCHAIN'` | `'OFFCHAIN'` не поддерживается |
| `protocolId` | `string` | `[A-Z_][A-Z0-9_]{0,31}` (via `asOnChainProtocolId`) | `'poly-market'` — дефис запрещён |
| `chainId` | `number` | `Number.isSafeInteger(n) && n > 0` | `-1`, `0`, `1.5`, `NaN`, `1e20` |
| `conditionId` | `string` | `0x` + ровно 64 hex-символа (via `isValidConditionId`) | `'0xabc'` — слишком короткий |

#### Поле outcomeKey

- Тип: `string`
- Не пустая
- Без control characters: U+0000–U+001F, U+007F–U+009F
- Без символов `:` и `\`
- Длина ≤ 32

```typescript
// ✅ Валидный OUTCOME_TOKEN asset
const tokenAsset = {
  type: 'OUTCOME_TOKEN' as const,
  conditionRef: {
    kind: 'ONCHAIN' as const,
    protocolId: 'POLYMARKET',
    chainId: 137,
    conditionId: '0x' + 'a'.repeat(64),
  },
  outcomeKey: 'YES',
};

// ❌ Невалидные примеры
{ kind: 'OFFCHAIN' }             // kind не ONCHAIN
{ protocolId: 'poly-market' }    // дефис запрещён
{ chainId: -1 }                  // отрицательный
{ chainId: 0 }                   // нулевой
{ chainId: 1.5 }                 // float
{ chainId: NaN }                 // не число
{ chainId: 1e20 }                // > MAX_SAFE_INTEGER
{ conditionId: '0xabc' }         // слишком короткий
{ outcomeKey: 'YES\x00' }        // control character U+0000
{ outcomeKey: 'YES:' }           // запрещённый символ ':'
{ outcomeKey: 'A'.repeat(33) }   // длина > 32
```

## Сравнение с AssetQuantity

| Аспект | AssetQuantity | Fee |
|--------|---------------|-----|
| **Семантика** | Общее количество актива | Комиссия (специализированное значение) |
| **Операции** | add, subtract, multiplyBy, divideBy | add (только для fees) |
| **Валидация add** | Проверяет asset match | Проверяет asset match + бросает FeeOperationError |
| **Use cases** | Позиции, балансы, любые количества | Trading fees, gas fees, settlement fees |

**Когда использовать Fee:**

- ✅ Trading fees (maker/taker)
- ✅ Settlement fees
- ✅ Gas fees
- ✅ Withdrawal fees

**Когда использовать AssetQuantity:**

- ✅ Позиции (holdings)
- ✅ Балансы
- ✅ Объёмы сделок

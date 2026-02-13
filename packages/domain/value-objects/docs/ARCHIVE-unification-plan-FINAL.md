# План унификации Value Objects - ФИНАЛЬНАЯ ВЕРСИЯ

> Статус: Одобрено, готово к реализации
> Дата: 2026-02-02

---

## Итоговые решения

### ✅ Коммит 1: Очистка ErrorReason enums

**Убрать дубликаты:**

**PriceErrorReason:**

- ❌ Удалить: `EXCEEDS_MAX_PRICE`, `NEGATIVE_PRICE`
- ✅ Использовать: `OUT_OF_RANGE_HIGH`, `OUT_OF_RANGE_LOW`

**QuantityErrorReason:**

- ❌ Удалить: `NEGATIVE_QUANTITY`, `EXCEEDS_MAX_QUANTITY`
- ✅ Использовать: `NEGATIVE`

---

### ✅ Коммит 2: Унификация констант на static readonly

**Price:**

```typescript
// УДАЛИТЬ методы и приватные константы:
private static readonly MIN_PRICE = ...
public static min(): Price
public static minValue(): Decimal

// ДОБАВИТЬ публичные константы:
public static readonly MIN = new Price(new Decimal('0.0001'));
public static readonly MAX = new Price(new Decimal('0.9999'));
public static readonly HALF = new Price(new Decimal('0.5'));
```

**Money:**

```typescript
// БЫЛО:
private static _zeroUSDC?: Money;
public static get ZERO_USDC(): Money { ... }

// СТАЛО:
public static readonly ZERO: Record<SupportedCurrency, Money> = {
  USDC: Money.fromDecimal(new Decimal(0), 'USDC'),
};

// Использование: Money.ZERO.USDC
```

**Quantity:** Оставить как есть (уже правильно)

---

### ✅ Коммит 3: Убрать ParseError из Money

**Упростить Money.of():**

```typescript
// БЫЛО:
try {
  decimal = new Decimal(value);
} catch (error) {
  throw new MoneyParseError(String(value));
}

// СТАЛО:
return Money.create(new Decimal(value), currency);
// Decimal бросит свою ошибку если не может распарсить
```

**Удалить файл:** `src/money/core/MoneyParseError.ts`

**Обновить MoneyService.create():**

```typescript
try {
  const money = Money.of(value, currency);
  return Ok(money);
} catch (error) {
  if (error instanceof MoneyInvariantViolation) {
    return Err(new InvalidMoneyError(...error.reason));
  }
  // Любая другая ошибка = INVALID_FORMAT
  return Err(new InvalidMoneyError(...INVALID_FORMAT));
}
```

**Price/Quantity:** Оставить как есть (уже правильно)

---

### ✅ Коммит 4: Унификация проверок инвариантов

**Единый порядок для всех: NaN → Finite → Domain-specific**

**Price:** Оставить как есть (уже правильно)

**Quantity:** Добавить явную проверку NaN

```typescript
// БЫЛО:
if (!v.isFinite()) throw ...NON_FINITE;
if (v.isNegative()) throw ...NEGATIVE;

// СТАЛО:
if (v.isNaN()) throw new QuantityInvariantViolation('...', QuantityErrorReason.NAN);
if (!v.isFinite()) throw new QuantityInvariantViolation('...', QuantityErrorReason.NON_FINITE);
if (v.isNegative()) throw new QuantityInvariantViolation('...', QuantityErrorReason.NEGATIVE);
```

**Money:** Переупорядочить

```typescript
// NaN → Finite → Currency → Max
if (amount.isNaN()) throw ...NAN;
if (!amount.isFinite()) throw ...NON_FINITE;
if (!SUPPORTED_CURRENCIES.has(currency)) throw ...UNSUPPORTED_CURRENCY;
if (amount.abs().greaterThan(MAX_AMOUNT)) throw ...EXCEEDS_MAX_AMOUNT;
```

---

### ✅ Коммит 5: Money.value() → value()

**BREAKING CHANGE**

**Money.ts:**

```typescript
// БЫЛО:
public amount(): Decimal { return this.amt; }
public toDecimal(): Decimal { return this.amt; }

// СТАЛО:
public value(): Decimal { return this.amt; }
// toDecimal() удалить
```

**Обновить вручную файл за файлом:**

- `src/money/facade/MoneyService.ts`
- `src/money/adapters/MoneyFormatter.ts`
- `src/money/adapters/MoneySerializer.ts`
- Все тесты Money (~50 мест)
- Документация (~10 файлов)

**Проверка после каждого файла:**

```bash
npm run build
npm test
```

---

### ✅ Коммит 6: Методы сравнения

**Price - добавить в Core:**

```typescript
isLessThan(other: Price): boolean
isLessThanOrEqual(other: Price): boolean
isGreaterThan(other: Price): boolean
isGreaterThanOrEqual(other: Price): boolean
```

**Quantity:** Оставить как есть (уже есть полный набор)

**Money - ТОЛЬКО в Facade:**

**Core (Money.ts):**

```typescript
// ОСТАВИТЬ:
hasSameCurrency(other: Money): boolean

// УДАЛИТЬ:
equals(other: Money): boolean  // Перенести в Facade
```

**Facade (MoneyService.ts) - добавить:**

```typescript
public static isLessThan(a: Money, b: Money): Result<boolean, InvalidMoneyError> {
  if (!a.hasSameCurrency(b)) {
    return Err(new InvalidMoneyError('Cannot compare different currencies', {
      context: {
        op: 'isLessThan',
        reason: MoneyErrorReason.CURRENCY_MISMATCH,
        expected: a.currency(),
        actual: b.currency()
      }
    }));
  }
  return Ok(a.value().lessThan(b.value()));
}

// Аналогично:
// - isLessThanOrEqual
// - isGreaterThan
// - isGreaterThanOrEqual
// - equals
// - isZero (проверка без currency)
// - isPositive
// - isNegative
```

---

### ✅ Коммит 7: Обновление документации

**Обновить:**

- Все примеры с `.value()` → `.value()`
- Все примеры с `Price.MIN` → `Price.MIN`
- Все примеры с `Money.ZERO.USDC` → `Money.ZERO.USDC`
- Добавить примеры методов сравнения
- Обновить architecture.md с новой единообразной структурой

---

## Порядок выполнения

1. **Коммит 1** - ErrorReason cleanup (безопасно, не ломает API)
2. **Коммит 2** - Константы (breaking для Price/Money)
3. **Коммит 3** - Убрать ParseError (упрощение)
4. **Коммит 4** - Проверки инвариантов (внутренние изменения)
5. **Коммит 5** - Money.value() → value() (breaking, массовая замена)
6. **Коммит 6** - Методы сравнения (новая функциональность)
7. **Коммит 7** - Документация (без кода)

**Проверка после каждого коммита:**

```bash
npm run build
npm test
npm run lint
npm run typecheck
```

---

## Ожидаемые breaking changes

1. `Money.value()` → `Money.value()`
2. `Money.toDecimal()` удален
3. `Price.MIN` → `Price.MIN`
4. `Price.MAX` → `Price.MAX`
5. `Price.HALF` → `Price.HALF`
6. `Price.MIN.value()/maxValue()` удалены
7. `Money.ZERO.USDC` → `Money.ZERO.USDC`
8. `Money.equals()` удален из Core, доступен через `MoneyService.equals()`
9. ErrorReason константы переименованы

---

## Метрики успеха

- ✅ Все три value objects имеют метод `value()`
- ✅ Единый порядок проверок инвариантов
- ✅ Нет дублирующихся ErrorReason констант
- ✅ Единый подход к константам (static readonly)
- ✅ Полный набор методов сравнения (Price/Quantity в Core, Money в Facade)
- ✅ Все 476+ тестов проходят
- ✅ Документация актуальна

---

## Готовы начать реализацию?

Начинаем с Коммита 1: Очистка ErrorReason enums

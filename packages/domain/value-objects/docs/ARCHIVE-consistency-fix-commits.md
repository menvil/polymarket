# Последовательность коммитов для унификации Value Objects

> Каждый коммит должен проходить все тесты
> Порядок минимизирует конфликты и упрощает откат

---

## Коммит 1: refactor(errors): cleanup ErrorReason enums duplicates

**Изменения:**

- `src/price/errors/PriceErrorReason.ts` - убрать EXCEEDS_MAX_PRICE, NEGATIVE_PRICE
- `src/quantity/errors/QuantityErrorReason.ts` - убрать NEGATIVE_QUANTITY, EXCEEDS_MAX_QUANTITY
- Заменить все использования в коде на унифицированные

**Затронутые файлы:**

- ErrorReason enums (2 файла)
- Все места использования удаленных констант (~10 мест)

**Тесты:** Обновить ассерты с новыми константами

```bash
npm test  # Все тесты должны пройти
```

---

## Коммит 2: refactor(core): replace constant methods with static readonly

**Изменения:**

**Price:**

- Добавить `public static readonly MIN/MAX/HALF`
- Удалить методы `min()`, `max()`, `half()`, `minValue()`, `maxValue()`

**Money:**

- Заменить lazy getter на `public static readonly ZERO_USDC`
- Удалить `private static _zeroUSDC`

**Затронутые файлы:**

- `src/price/core/Price.ts`
- `src/money/core/Money.ts`
- `src/price/facade/PriceService.ts` - заменить `Price.MIN` на `Price.MIN`
- `src/price/rules/**` - заменить `Price.MIN.value()` на `Price.MIN.value()`
- Все тесты Price и Money

```bash
npm run build
npm test
```

---

## Коммит 3: feat(core): add ParseError for Price and Quantity

**Изменения:**

**Новые файлы:**

- `src/price/core/PriceParseError.ts`
- `src/quantity/core/QuantityParseError.ts`

**Обновления:**

- `src/price/core/Price.ts` - `of()` обрабатывает parse errors
- `src/quantity/core/Quantity.ts` - `of()` обрабатывает parse errors
- `src/price/core/index.ts` - экспорт PriceParseError
- `src/quantity/core/index.ts` - экспорт QuantityParseError
- `src/price/facade/PriceService.ts` - catch PriceParseError
- `src/quantity/facade/QuantityService.ts` - catch QuantityParseError

**Новые тесты:**

- `__tests__/unit/price/core/Price.test.ts` - ParseError тесты
- `__tests__/unit/quantity/core/Quantity.test.ts` - ParseError тесты
- `__tests__/unit/price/facade/PriceService.test.ts` - обработка ParseError
- `__tests__/unit/quantity/facade/QuantityService.test.ts` - обработка ParseError

```bash
npm run build
npm test
```

---

## Коммит 4: refactor(core): unify invariant checks order

**Изменения:**

**Все три класса (Price, Quantity, Money):**

- Единый порядок: NaN → Finite → Domain-specific
- Явные проверки NaN и Finite (не полагаться на isFinite покрывает NaN)

**Файлы:**

- `src/price/core/Price.ts` - порядок уже правильный, добавить комментарии
- `src/quantity/core/Quantity.ts` - добавить явную проверку NaN перед Finite
- `src/money/core/Money.ts` - переупорядочить: NaN → Finite → Currency → Max

**Обновления тестов:**

- Проверить что NaN выбрасывает NAN reason (не NON_FINITE)

```bash
npm test
```

---

## Коммит 5: refactor(money)!: rename amount() to value() for consistency

### BREAKING CHANGE

**Изменения:**

**Core:**

- `src/money/core/Money.ts`:
  - `amount()` → `value()`
  - Удалить `toDecimal()` алиас

**Facade:**

- `src/money/facade/MoneyService.ts` - все `.value()` → `.value()`

**Adapters:**

- `src/money/adapters/MoneyFormatter.ts` - все `.value()` → `.value()`
- `src/money/adapters/MoneySerializer.ts` - все `.value()` → `.value()`

**Тесты:**

- `__tests__/unit/money/**/*.test.ts` - все `.value()` → `.value()`

**Команда для поиска:**

```bash
grep -r "\.value()" packages/domain/value-objects/src/money/
grep -r "\.value()" packages/domain/value-objects/__tests__/unit/money/
```

**Автоматическая замена:**

```bash
find packages/domain/value-objects/src/money -name "*.ts" -exec sed -i '' 's/\.value()/\.value()/g' {} \;
find packages/domain/value-objects/__tests__/unit/money -name "*.test.ts" -exec sed -i '' 's/\.value()/\.value()/g' {} \;
```

```bash
npm run build
npm test
```

---

## Коммит 6: feat(core): add comparison methods to Price and Money

**Изменения:**

**Price:**

- Добавить `isLessThan`, `isLessThanOrEqual`, `isGreaterThan`, `isGreaterThanOrEqual`

**Money:**

- Добавить `isLessThan`, `isLessThanOrEqual`, `isGreaterThan`, `isGreaterThanOrEqual`
- Добавить `isZero`, `isPositive`, `isNegative`
- Добавить `private assertSameCurrency()`

**Файлы:**

- `src/price/core/Price.ts`
- `src/money/core/Money.ts`

**Новые тесты:**

- `__tests__/unit/price/core/Price.test.ts` - тесты методов сравнения
- `__tests__/unit/money/core/Money.test.ts` - тесты методов сравнения + isZero/isPositive

```bash
npm test
```

---

## Коммит 7: docs: update all documentation for consistency changes

### BREAKING CHANGE documentation

**Изменения:**

**Money документация:**

- `docs/money/**/*.md` - все `.value()` → `.value()`

**Все value objects:**

- Добавить примеры ParseError vs InvariantViolation
- Обновить примеры констант (методы → static readonly)
- Добавить примеры методов сравнения

**Файлы:**

- `docs/money/core.md`
- `docs/money/facade.md`
- `docs/money/adapters.md`
- `docs/money/examples.md`
- `docs/money/migration.md`
- `docs/price/core.md`
- `docs/price/facade.md`
- `docs/quantity/core.md`
- `docs/quantity/facade.md`
- `docs/README.md`

**Команда для поиска:**

```bash
grep -r "\.value()" packages/domain/value-objects/docs/money/
grep -r "Price\.min()" packages/domain/value-objects/docs/
```

```bash
npm run lint:md:fix
```

---

## Итоговый summary коммит

```bash
git log --oneline HEAD~7..HEAD
```

Ожидаемый вывод:

```text
9a1b2c3 docs: update all documentation for consistency changes
8d7e6f5 feat(core): add comparison methods to Price and Money
7c5d4e3 refactor(money)!: rename amount() to value() for consistency
6b4c3d2 refactor(core): unify invariant checks order
5a3b2c1 feat(core): add ParseError for Price and Quantity
4d2e1f0 refactor(core): replace constant methods with static readonly
3c1b0a9 refactor(errors): cleanup ErrorReason enums duplicates
```

---

## Финальная проверка

```bash
# Сборка
npm run build

# Все тесты
npm test

# Линтинг
npm run lint
npm run typecheck

# Markdown
npm run lint:md

# Git статус
git status
```

**Ожидаемый результат:**

- ✅ Сборка без ошибок
- ✅ Все 476+ тестов проходят
- ✅ Линтер без ошибок
- ✅ TypeScript без ошибок
- ✅ Markdown без критичных ошибок
- ✅ Git clean (все изменения закоммичены)

---

## CHANGELOG entry

```markdown
## [2.0.0] - 2026-02-02

### Breaking Changes

- **Money**: Renamed `amount()` to `value()` for consistency with Price and Quantity
- **Money**: Removed `toDecimal()` alias (use `value()` instead)
- **Price**: Replaced methods `min()`, `max()`, `half()` with static readonly constants `MIN`, `MAX`, `HALF`
- **Price**: Removed internal methods `minValue()`, `maxValue()`
- **Money**: Replaced lazy getter `ZERO_USDC` with static readonly constant
- **Price/Quantity ErrorReasons**: Removed duplicate constants (use `OUT_OF_RANGE_LOW/HIGH` and `NEGATIVE`)

### Added

- **Price/Quantity**: Added `ParseError` classes to distinguish parse errors from invariant violations
- **Price**: Added comparison methods: `isLessThan`, `isGreaterThan`, `isLessThanOrEqual`, `isGreaterThanOrEqual`
- **Money**: Added comparison methods: `isLessThan`, `isGreaterThan`, `isLessThanOrEqual`, `isGreaterThanOrEqual`, `isZero`, `isPositive`, `isNegative`

### Changed

- **All Value Objects**: Unified invariant validation order (NaN → Finite → Domain-specific)
- **Quantity**: Added explicit NaN check before Finite check for consistency

### Migration Guide

```typescript
// Money - rename method calls
// Before:
const decimal = money.value();
const num = money.toDecimal();

// After:
const decimal = money.value();
const num = money.value();  // toDecimal() removed

// Price - use constants instead of methods
// Before:
const min = Price.MIN;
const max = Price.MAX;
const half = Price.HALF;

// After:
const min = Price.MIN;
const max = Price.MAX;
const half = Price.HALF;

// Money - use constant directly
// Before:
const zero = Money.ZERO.USDC;  // Still works but now static readonly

// After:
const zero = Money.ZERO.USDC;  // Same, but no lazy init

// ErrorReasons - use unified constants
// Before (Price):
PriceErrorReason.NEGATIVE_PRICE
PriceErrorReason.EXCEEDS_MAX_PRICE

// After:
PriceErrorReason.OUT_OF_RANGE_LOW
PriceErrorReason.OUT_OF_RANGE_HIGH

// Before (Quantity):
QuantityErrorReason.NEGATIVE_QUANTITY

// After:
QuantityErrorReason.NEGATIVE
```

```text

---

## Откат в случае проблем

Каждый коммит независим, можно откатить отдельно:

```bash
# Откатить последний коммит
git revert HEAD

# Откатить конкретный коммит
git revert <commit-hash>

# Откатить все изменения
git revert HEAD~7..HEAD
```

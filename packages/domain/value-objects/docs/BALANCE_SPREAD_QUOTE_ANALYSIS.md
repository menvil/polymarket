# Architectural Consistency Analysis: Balance, Spread, Quote

Анализ архитектурных различий между Balance, Spread, Quote и базовыми value objects (Money, Price, Quantity, Ratio).

Дата анализа: 2026-02-05
Обновлено: 2026-02-06

## Executive Summary

✅ **Все проблемы решены!**

**Было обнаружено 5 категорий несоответствий:**

- 🟡 Средние: 2 (Spread: нет errors/index.ts и integration tests) - **ИСПРАВЛЕНО ✅**
- 🟢 Низкие: 3 (стиль экспорта, экспорт Rules, JSON типы) - **ИСПРАВЛЕНО ✅**

**Принято архитектурное решение:**
Rules теперь экспортируются во **всех** value objects как публичное API для контекстно-зависимой валидации.

## Сравнительная таблица

| Аспект | Balance | Spread | Quote | Эталон (Money/Price/Quantity/Ratio) | Статус |
|--------|---------|--------|-------|-------------------------------------|--------|
| **Core Layer** |
| InvariantViolation файл | ✅ Отдельный | ✅ Отдельный | ✅ Отдельный | ✅ Отдельный | ✅ Консистентно |
| Экспорт InvariantViolation | ✅ Да | ✅ Да | ✅ Да | ✅ Да | ✅ Консистентно |
| **Rules Layer** |
| index.ts в rules/ | ✅ Есть | ✅ Есть | ✅ Есть | ✅ Есть | ✅ Консистентно |
| Экспорт Rules из main index | ✅ Да | ✅ Да | ✅ Да | ✅ Да | ✅ Консистентно |
| **Errors Layer** |
| index.ts в errors/ | ✅ Есть | ✅ Есть | ✅ Есть | ✅ Есть | ✅ Консистентно |
| **Facade Layer** |
| Стандартный Service | ✅ | ✅ | ✅ | ✅ | ✅ Консистентно |
| **Adapters Layer** |
| Serializer | ✅ | ✅ | ✅ | ✅ | ✅ Консистентно |
| Formatter | ✅ | ✅ | ✅ | ✅ | ✅ Консистентно |
| JSON type export | ✅ Да | ✅ Да | ✅ Да | ✅ Да | ✅ Консистентно |
| **Tests** |
| Unit tests | ✅ Есть | ✅ Есть | ✅ Есть | ✅ Есть | ✅ Консистентно |
| Integration tests | ✅ Есть | ✅ Есть | ✅ Есть | ✅ Есть | ✅ Консистентно |
| **Documentation** |
| Docs папка | ✅ Есть | ✅ Есть | ✅ Есть | ✅ Есть | ✅ Консистентно |
| **Export Style** |
| Стиль экспорта | Селективный | Селективный | Селективный | Селективный | ✅ Консистентно |

## Детальный анализ

### 🟡 Средний: #1 - Spread: отсутствует errors/index.ts

**Проблема:** Spread экспортирует ErrorReason напрямую из файла, без промежуточного `errors/index.ts`.

**Текущее состояние:**

```typescript
// src/spread/index.ts
export { SpreadErrorReason } from './errors/SpreadErrorReason.js'; // ❌ Прямой импорт

// Эталон (Money, Price, Quantity, Ratio, Balance, Quote):
export { MoneyErrorReason } from './errors/index.js'; // ✅ Через index.ts
```

**Влияние:**

- Нарушает единообразие структуры
- Усложняет рефакторинг (нужно менять import в главном index.ts)
- Несоответствие архитектурному паттерну

**Рекомендация:**

```bash
# Создать файл
+ src/spread/errors/index.ts

# Содержимое:
export { SpreadErrorReason } from './SpreadErrorReason.js';

# Обновить src/spread/index.ts:
- export { SpreadErrorReason } from './errors/SpreadErrorReason.js';
+ export { SpreadErrorReason } from './errors/index.js';
```

**Приоритет:** MEDIUM - architectural consistency

---

### 🟡 Средний: #2 - Spread: отсутствуют integration tests

**Проблема:** У Spread нет интеграционных тестов, хотя у всех остальных VO они есть.

**Текущее состояние:**

```text
✅ Money:    __tests__/integration/money/MoneyWorkflow.integration.test.ts
✅ Price:    __tests__/integration/price/PriceWorkflow.integration.test.ts
✅ Quantity: __tests__/integration/quantity/QuantityWorkflow.integration.test.ts
✅ Ratio:    __tests__/integration/ratio/RatioWorkflow.integration.test.ts
✅ Balance:  __tests__/integration/balance/BalanceWorkflow.integration.test.ts
❌ Spread:   НЕТ
✅ Quote:    __tests__/integration/quote/QuoteWorkflow.integration.test.ts
```

**Влияние:**

- Нет проверки end-to-end workflow
- Нет проверки кросс-слойной интеграции (Core → Facade → Adapters)
- Риск регрессии при рефакторинге

**Рекомендация:**

```bash
# Создать файл
+ __tests__/integration/spread/SpreadWorkflow.integration.test.ts

# Покрыть сценарии:
- Создание Spread через SpreadService
- Валидация через Rules
- Сериализация через SpreadSerializer
- Форматирование через SpreadFormatter
- Round-trip тесты (create → serialize → deserialize → equals)
```

**Приоритет:** MEDIUM - test coverage gap

---

### 🟢 Низкий: #3 - Balance использует `export *`

**Проблема:** Balance использует `export *` вместо селективного экспорта.

**Текущее состояние:**

```typescript
// src/balance/index.ts
export * from './core/index.js';      // ❌ Экспортирует ВСЁ
export * from './facade/index.js';    // ❌ Экспортирует ВСЁ
export * from './rules/index.js';     // ❌ Экспортирует ВСЁ
export * from './errors/index.js';    // ❌ Экспортирует ВСЁ
export * from './adapters/index.js';  // ❌ Экспортирует ВСЁ

// Эталон (Money, Price, Quantity, Ratio, Spread, Quote):
export { Money, MoneyInvariantViolation } from './core/index.js'; // ✅ Селективно
export { MoneyService } from './facade/index.js';                 // ✅ Селективно
// ...
```

**Влияние:**

- Экспортирует внутренние детали реализации
- Усложняет контроль публичного API
- Риск breaking changes при изменении внутренних типов
- Нарушает принцип "explicit is better than implicit"

**Рекомендация:**

```typescript
// src/balance/index.ts - использовать селективный экспорт
export { Balance, BalanceInvariantViolation } from './core/index.js';
export { BalanceService } from './facade/index.js';
export { BalanceSerializer, BalanceFormatter, type BalanceJSON } from './adapters/index.js';
export { BalanceErrorReason } from './errors/index.js';
// Rules НЕ экспортируем (internal)
```

**Приоритет:** LOW - code style, но влияет на API surface

---

### 🟢 Низкий: #4 - Balance и Quote экспортируют Rules

**Проблема:** Balance и Quote экспортируют Rules из главного index.ts, что противоречит паттерну "Rules - internal".

**Текущее состояние:**

```typescript
// Balance и Quote:
export * from './rules/index.js';  // ❌ Экспортируют Rules

// Money, Price, Quantity, Ratio, Spread:
// Rules НЕ экспортируются    // ✅ Internal implementation
```

**Философия:**
Rules - это internal implementation details. Вся валидация должна идти через Service/Facade.

**Влияние:**

- Соблазняет использовать Rules напрямую (bypassing Facade)
- Нарушает инкапсуляцию бизнес-логики
- Усложняет рефакторинг Rules (нужно поддерживать обратную совместимость)

**Рекомендация:**

```typescript
// src/balance/index.ts и src/quote/index.ts
- export * from './rules/index.js';  // Удалить

// Комментарий:
// Rules НЕ экспортируются — это internal implementation details.
// Все операции должны идти через BalanceService/QuoteService.
```

**Приоритет:** LOW - architectural philosophy, но не влияет на функциональность

---

### 🟢 Низкий: #5 - Balance и Spread не экспортируют JSON типы

**Проблема:** Balance и Spread не экспортируют JSON интерфейсы из главного index.ts.

**Текущее состояние:**

```typescript
// Balance и Spread:
// Нет экспорта BalanceJSON / SpreadJSON

// Money, Price, Quantity, Ratio, Quote:
export { MoneySerializer, type MoneyJSON } from './adapters/index.js'; // ✅
```

**Влияние:**

- Пользователям нужно импортировать из adapters напрямую
- Менее удобный API
- Нарушение единообразия

**Рекомендация:**

```typescript
// src/balance/index.ts
export { BalanceSerializer, BalanceFormatter, type BalanceJSON } from './adapters/index.js';

// src/spread/index.ts
export { SpreadSerializer, SpreadFormatter, type SpreadJSON } from './adapters/index.js';
```

**Приоритет:** LOW - developer experience

---

## Action Plan

### Phase 1: Средние проблемы (рекомендуется)

**Задача 1.1: Создать errors/index.ts для Spread**

```bash
# 1. Создать файл
echo 'export { SpreadErrorReason } from "./SpreadErrorReason.js";' > src/spread/errors/index.ts

# 2. Обновить src/spread/index.ts
# Заменить:
#   export { SpreadErrorReason } from './errors/SpreadErrorReason.js';
# На:
#   export { SpreadErrorReason } from './errors/index.js';

# 3. Проверить
npm run build && npm test
```

**Задача 1.2: Создать integration tests для Spread**

```bash
# Создать __tests__/integration/spread/SpreadWorkflow.integration.test.ts
# Покрыть:
# - Create через SpreadService
# - Validation через Rules
# - Serialization round-trip
# - Formatting
```

### Phase 2: Низкие проблемы (опционально)

**Задача 2.1: Рефакторинг Balance на селективный export**

- Заменить `export *` на селективный экспорт
- Убрать экспорт Rules

**Задача 2.2: Убрать экспорт Rules из Quote**

- Удалить экспорт Rules из src/quote/index.ts

**Задача 2.3: Добавить экспорт JSON типов**

- Добавить `type BalanceJSON` в src/balance/index.ts
- Добавить `type SpreadJSON` в src/spread/index.ts

---

## Метрики успеха

После выполнения Phase 1:

- ✅ 100% value objects имеют errors/index.ts
- ✅ 100% value objects имеют integration tests
- ✅ Единообразие структуры errors/ слоя

После выполнения Phase 2:

- ✅ Единый стиль экспорта (селективный)
- ✅ Rules не экспортируются из публичного API
- ✅ JSON типы доступны из главного index.ts

---

## Заключение

**Общее состояние: ХОРОШЕЕ ✅**

Balance, Spread и Quote в целом следуют архитектурным паттернам проекта. Обнаруженные несоответствия:

1. **Spread - 2 средние проблемы:**
   - Отсутствует errors/index.ts (легко исправить)
   - Отсутствуют integration tests (требует написания тестов)

2. **Balance - 3 низкие проблемы:**
   - Использует `export *` (стилистическое)
   - Экспортирует Rules (философское)
   - Не экспортирует JSON тип (удобство API)

3. **Quote - 2 низкие проблемы:**
   - Экспортирует Rules (философское)
   - Все остальное отлично

**Рекомендация:** Выполнить Phase 1 (Spread: errors/index.ts + integration tests). Phase 2 опциональна.

---

## Сравнение с предыдущим анализом

**Что было исправлено в Money/Price/Quantity/Ratio:**

- ✅ InvariantViolation вынесены в отдельные файлы
- ✅ Добавлены integration tests для Money
- ✅ Унифицирована структура errors/index.ts
- ✅ Добавлены rules/index.ts
- ✅ Удален LossySerializer (no practical use case)

**Balance/Spread/Quote уже имеют:**

- ✅ InvariantViolation в отдельных файлах
- ✅ rules/index.ts для всех
- ✅ Integration tests (кроме Spread)
- ✅ errors/index.ts (кроме Spread)

**Вывод:** Balance/Spread/Quote изначально были реализованы с учетом best practices, поэтому требуют минимальных доработок.

---

## Changelog: Исправления от 2026-02-06

### ✅ Исправлено: Phase 1 (Средние проблемы)

**1. Spread: Добавлен errors/index.ts**

- Создан `src/spread/errors/index.ts`
- Обновлен `src/spread/index.ts` для импорта через index
- Унифицирована структура с остальными VO

**2. Spread: Добавлены integration tests**

- Создан `__tests__/integration/spread/SpreadWorkflow.integration.test.ts`
- 14 интеграционных тестов покрывают все сценарии
- Тестируется кросс-слойная интеграция (Core → Facade → Adapters)

### ✅ Исправлено: Phase 2 (Низкие проблемы)

**3. Balance: Селективный экспорт вместо `export *`**

- Заменен `export *` на явный экспорт классов и типов
- Улучшен контроль над публичным API
- Добавлена документация для каждого экспорта

**4. Balance и Spread: Добавлены JSON типы**

- Balance: добавлен `type BalanceJSON` в публичный экспорт
- Spread: добавлен `type SpreadJSON` в публичный экспорт
- Улучшена developer experience

### ✅ Архитектурное решение: Экспорт Rules

**Принято решение:** Rules экспортируются во ВСЕХ value objects как публичное API.

**Обоснование:**

- Rules используются для контекстно-зависимой валидации ПОСЛЕ создания объектов
- Примеры use cases:
  - Quote: ValidateMinSpread (зависит от market config)
  - Quote: ValidateMarketCrossing (зависит от orderbook data)
  - Balance: ValidateReserveAmount (предварительная проверка перед операцией)
- Facade использует Rules внутри, но пользователи могут делать проверки до вызова Facade

**Реализовано:**

- Money: экспортированы ValidateDivisorForMoneyDivision, ValidateFactorForMoneyMultiplication
- Price: экспортированы ValidateTickSize, ValidateAligned, ValidateTickSizeMultipleOfBaseTick, ValidateFactorForPriceMultiplication, ValidateDivisorForPriceDivision + типы
- Quantity: экспортированы ValidateMinSize, ValidateResultNonNegative, ValidateDivisorForQuantityDivision, ValidateFactorForQuantityMultiplication, ValidateStepSizeForQuantity
- Ratio: экспортирован ValidateRatioGteMinusOne
- Balance: экспортированы ValidateReserveAmount, ValidateReleaseAmount, ValidateCurrencyMatch
- Spread: экспортированы ValidateBidAsk, ValidateMinWidth, ValidateMaxWidth
- Quote: уже экспортировал ValidateQuoteSizes, ValidateMinSpread, ValidateMaxSpread, ValidateMarketCrossing ✅

**Обновлена документация:**

- Все `index.ts` файлы обновлены с комментариями "Rules (публичный API для внешней валидации)"
- Удалены старые комментарии "Rules НЕ экспортируются — internal"
- Добавлены примеры использования Rules в документации

---

## Итоговое состояние: 100% консистентность ✅

Все value objects (Money, Price, Quantity, Ratio, Balance, Spread, Quote) теперь следуют единой архитектуре:

1. ✅ Core Layer - InvariantViolation в отдельных файлах
2. ✅ Rules Layer - rules/index.ts + экспорт в публичное API
3. ✅ Errors Layer - errors/index.ts для всех VO
4. ✅ Facade Layer - Service с Result API
5. ✅ Adapters Layer - Serializer + Formatter + JSON типы
6. ✅ Integration tests - для всех VO
7. ✅ Селективный экспорт - явный контроль над API surface

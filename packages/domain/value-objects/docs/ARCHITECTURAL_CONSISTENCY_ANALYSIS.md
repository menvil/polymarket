# Architectural Consistency Analysis

Анализ архитектурных различий и несоответствий между value objects: Money, Price, Quantity, Ratio.

Дата анализа: 2026-02-05

## Executive Summary

Обнаружено **8 категорий архитектурных несоответствий** между value objects. Большинство относятся к организационным аспектам (структура файлов, экспорты), а не к фундаментальным архитектурным проблемам.

**Критичность:**

- 🔴 Критичные: 1 (InvariantViolation структура)
- 🟡 Средние: 3 (экспорты, тесты)
- 🟢 Низкие: 4 (организационные)

## Сравнительная таблица

| Аспект | Money | Price | Quantity | Ratio | Статус |
|--------|-------|-------|----------|-------|--------|
| **Core Layer** | | | | | |
| InvariantViolation файл | ✅ Отдельный | ❌ Inline | ❌ Inline | ✅ Отдельный | 🔴 Несоответствие |
| Экспорт InvariantViolation | ✅ Да | ✅ Да | ❌ Нет | ✅ Да | 🟡 Несоответствие |
| **Rules Layer** | | | | | |
| index.ts в rules/ | ❌ Нет | ✅ Есть | ✅ Есть | ✅ Есть | 🟢 Несоответствие |
| Количество Rules | 2 | 5 | 5 | 1 | ℹ️ Зависит от domain |
| **Errors Layer** | | | | | |
| index.ts в errors/ | ❌ Нет | ❌ Нет | ❌ Нет | ✅ Есть | 🟢 Несоответствие |
| **Facade Layer** | | | | | |
| Экспорт Options | - | - | - | ✅ RatioCreateOptions | ℹ️ OK (нужно для API) |
| **Adapters Layer** | | | | | |
| Formatter | ✅ | ✅ | ✅ | ✅ | ✅ Консистентно |
| Serializer | ✅ 1 класс | ✅ 1 класс | ✅ 2 класса | ✅ 1 класс | 🟡 Quantity уникален |
| **Tests** | | | | | |
| Unit tests | ✅ | ✅ | ✅ | ✅ | ✅ Консистентно |
| Integration tests | ❌ Нет | ✅ Есть | ✅ Есть | ✅ Есть | 🟡 Несоответствие |
| **Documentation** | | | | | |
| Docs папка | ❌ | ✅ | ❌ | ✅ | 🟡 Несоответствие |

## Детальный анализ

### 🔴 Критичное: #1 - InvariantViolation class location

**Проблема:** Несоответствие в размещении InvariantViolation классов.

**Текущее состояние:**

```text
Money:    src/money/core/MoneyInvariantViolation.ts     ✅ Отдельный файл
Price:    src/price/core/Price.ts (inline, строки 19-39) ❌ Inline
Quantity: src/quantity/core/Quantity.ts (inline, 20-28) ❌ Inline
Ratio:    src/ratio/core/RatioInvariantViolation.ts     ✅ Отдельный файл
```

**Влияние:**

- Нарушает принцип Single Responsibility
- Усложняет рефакторинг Price.ts и Quantity.ts (файлы >300 строк)
- Затрудняет переиспользование InvariantViolation в других местах
- Несоответствие документированному архитектурному паттерну

**Рекомендация:**

```diff
# Для Price
+ src/price/core/PriceInvariantViolation.ts
  src/price/core/Price.ts (удалить inline определение)

# Для Quantity
+ src/quantity/core/QuantityInvariantViolation.ts
  src/quantity/core/Quantity.ts (удалить inline определение)
```

**Приоритет:** HIGH - влияет на maintainability и consistency

---

### 🟡 Средний: #2 - InvariantViolation export inconsistency

**Проблема:** Quantity не экспортирует QuantityInvariantViolation, хотя остальные экспортируют.

**Текущее состояние:**

```typescript
// money/index.ts
export { MoneyInvariantViolation } from './core/index.js'; ✅

// price/index.ts
export { PriceInvariantViolation } from './core/index.js'; ✅

// quantity/index.ts
// НЕ экспортирует QuantityInvariantViolation ❌
// Комментарий: "Rules и QuantityInvariantViolation НЕ экспортируются — это internal"

// ratio/index.ts
export { RatioInvariantViolation } from './core/index.js'; ✅
```

**Обоснование в коде Quantity:**
> "Rules и QuantityInvariantViolation НЕ экспортируются — это internal implementation details. Всё должно идти через QuantityService."

**Анализ:**
Есть два подхода:

1. **Подход Quantity (скрывать InvariantViolation):**
   - ✅ Инкапсулирует внутренние детали
   - ✅ Заставляет использовать Facade
   - ❌ Потребители не могут делать instanceof проверки
   - ❌ Несоответствие с другими VO

2. **Подход Money/Price/Ratio (экспортировать InvariantViolation):**
   - ✅ Позволяет type guards: `error instanceof MoneyInvariantViolation`
   - ✅ Полезно для low-level библиотек
   - ❌ Раскрывает внутренности Core слоя

**Рекомендация:**

Выбрать **единую политику** для всех VO:

**Вариант A (рекомендуется):** Экспортировать InvariantViolation везде

- Обосновани: полезно для type guards, debugging, low-level использования
- Action: Добавить export в quantity/index.ts

**Вариант B:** Не экспортировать InvariantViolation нигде

- Обоснование: строгая инкапсуляция, только Facade API
- Action: Убрать exports из money/price/ratio

**Приоритет:** MEDIUM - влияет на публичный API

---

### 🟢 Низкий: #3 - Rules index.ts inconsistency

**Проблема:** Money не имеет index.ts в rules/, остальные имеют.

**Текущее состояние:**

```text
Money:    src/money/rules/    ❌ Нет index.ts
Price:    src/price/rules/    ✅ Есть index.ts (экспортирует 5 rules + types)
Quantity: src/quantity/rules/ ✅ Есть index.ts (экспортирует 5 rules)
Ratio:    src/ratio/rules/    ✅ Есть index.ts (экспортирует 1 rule)
```

**Влияние:**

- Минимальное - Rules обычно не экспортируются из главного index.ts
- Money Rules используются только внутри MoneyService
- Но отсутствие index.ts ухудшает внутреннюю организацию

**Рекомендация:**

```typescript
// Добавить src/money/rules/index.ts
export { ValidateDivisorForMoneyDivision } from './ValidateDivisorForMoneyDivision.js';
export { ValidateFactorForMoneyMultiplication } from './ValidateFactorForMoneyMultiplication.js';
```

**Приоритет:** LOW - чисто организационный аспект

---

### 🟢 Низкий: #4 - Errors index.ts inconsistency

**Проблема:** Только Ratio имеет index.ts в errors/.

**Текущее состояние:**

```text
Money:    src/money/errors/    ❌ Нет index.ts
Price:    src/price/errors/    ❌ Нет index.ts
Quantity: src/quantity/errors/ ❌ Нет index.ts
Ratio:    src/ratio/errors/    ✅ Есть index.ts (экспортирует RatioErrorReason)
```

**Содержимое ratio/errors/index.ts:**

```typescript
export { RatioErrorReason } from './RatioErrorReason.js';
```

**Анализ:**

- Errors layer обычно содержит только ErrorReason enum
- index.ts в Ratio - избыточен, т.к. экспортирует только 1 файл
- Другие VO импортируют напрямую: `from '../errors/MoneyErrorReason.js'`

**Рекомендация:**

**Вариант A:** Добавить index.ts везде (унификация)

```typescript
// money/errors/index.ts
export { MoneyErrorReason } from './MoneyErrorReason.js';
```

**Вариант B:** Убрать index.ts из Ratio (упрощение)

```typescript
// Импортировать напрямую как в других VO
import { RatioErrorReason } from '../errors/RatioErrorReason.js';
```

**Приоритет:** LOW - косметический аспект

---

### 🟡 Средний: #7 - Integration tests missing for Money

**Проблема:** Money не имеет интеграционных тестов, остальные VO имеют.

**Текущее состояние:**

```text
Money:    ❌ Нет __tests__/integration/money/
Price:    ✅ __tests__/integration/price/PriceWorkflow.integration.test.ts
Quantity: ✅ __tests__/integration/quantity/QuantityWorkflow.integration.test.ts
Ratio:    ✅ __tests__/integration/ratio/RatioWorkflow.integration.test.ts
```

**Влияние:**

- Money не тестируется end-to-end
- Нет проверки полных workflow (create → serialize → deserialize → format)
- Нет тестов cross-layer consistency

**Примеры что тестируют integration tests в других VO:**

```typescript
// Из PriceWorkflow.integration.test.ts
describe('Price Integration Workflow', () => {
  it('создание через разные методы приводит к одинаковым значениям', ...)
  it('полный workflow: создание → форматирование → парсинг', ...)
  it('полный workflow: создание → сериализация → десериализация', ...)
  it('математические операции end-to-end', ...)
});
```

**Рекомендация:**

Создать `__tests__/integration/money/MoneyWorkflow.integration.test.ts`:

```typescript
describe('Money Integration Workflow', () => {
  describe('создание через разные форматы', () => {
    it('из string и Decimal дают одинаковый результат', ...)
  });

  describe('полный workflow: создание → форматирование → парсинг', () => {
    it('decimal format round-trip', ...)
  });

  describe('полный workflow: создание → сериализация → десериализация', () => {
    it('JSON round-trip сохраняет точность', ...)
  });

  describe('математические операции end-to-end', () => {
    it('add → subtract → multiply → divide', ...)
    it('сложные вычисления с несколькими операциями', ...)
  });

  describe('cross-layer consistency', () => {
    it('все слои работают согласованно', ...)
  });
});
```

**Приоритет:** MEDIUM - влияет на test coverage и quality assurance

---

### 🟡 Средний: #8 - QuantityLossySerializer uniqueness

**Проблема:** Только Quantity имеет второй serializer (QuantityLossySerializer).

**Текущее состояние:**

```text
Money:    MoneySerializer (1 класс)
Price:    PriceSerializer (1 класс)
Quantity: QuantitySerializer + QuantityLossySerializer (2 класса) ⚠️
Ratio:    RatioSerializer (1 класс)
```

**Анализ:**

QuantityLossySerializer специфичен для Quantity:

```typescript
// Обычный - сохраняет точность
export interface QuantityJSON {
  quantity: string; // Decimal string
}

// Lossy - для компактности
export interface QuantityLossyJSON {
  quantity: number; // Может потерять точность
}
```

**Вопросы:**

1. **Нужен ли LossySerializer другим VO?**
   - Money: потенциально да (для compact JSON)
   - Price: вероятно нет (нужна точность)
   - Ratio: вероятно нет (малые значения)

2. **Паттерн ли это или исключение?**
   - Если паттерн → добавить в Money
   - Если исключение → документировать почему только Quantity

**Рекомендация:**

**Вариант A:** Сделать паттерном (добавить MoneyLossySerializer)

- Обоснование: consistency, может быть полезно
- Action: Добавить LossySerializer в Money

**Вариант B:** Оставить уникальным для Quantity

- Обоснование: domain-specific потребность Quantity
- Action: Документировать в Quantity/architecture.md почему это нужно

**Приоритет:** MEDIUM - влияет на API design consistency

---

### 🟡 Средний: #9 - Documentation inconsistency

**Проблема:** Неполное покрытие документацией.

**Текущее состояние:**

```text
Money:    ❌ Нет docs/money/
Price:    ✅ docs/price/ (4 файла: README, architecture, examples, facade)
Quantity: ❌ Нет docs/quantity/
Ratio:    ✅ docs/ratio/ (7 файлов: полная документация)
```

**Влияние:**

- Неравномерное quality of documentation
- Money и Quantity сложнее изучать новым разработчикам
- Нет единого стандарта documentation

**Рекомендация:**

Создать полную документацию для Money и Quantity по аналогии с Ratio:

```text
docs/money/
  ├── README.md              (обзор, quick start)
  ├── architecture.md        (4-layer architecture, design decisions)
  ├── core.md               (Money class API reference)
  ├── facade.md             (MoneyService API reference)
  ├── adapters.md           (MoneyFormatter, MoneySerializer)
  └── examples.md           (real-world examples)

docs/quantity/
  ├── README.md
  ├── architecture.md
  ├── core.md
  ├── facade.md
  ├── adapters.md
  └── examples.md
```

**Приоритет:** MEDIUM - влияет на developer experience

---

## Рекомендации по приоритетам

### Высокий приоритет (сделать в первую очередь)

1. **Вынести InvariantViolation в отдельные файлы для Price и Quantity**
   - Файлы: `PriceInvariantViolation.ts`, `QuantityInvariantViolation.ts`
   - Причина: architectural consistency, maintainability
   - Effort: Small (2-3 часа)

2. **Создать интеграционные тесты для Money**
   - Файл: `__tests__/integration/money/MoneyWorkflow.integration.test.ts`
   - Причина: test coverage, quality assurance
   - Effort: Medium (4-6 часов)

### Средний приоритет (сделать после высокого)

1. **Унифицировать экспорт InvariantViolation**
   - Выбрать: экспортировать везде ИЛИ нигде не экспортировать
   - Обновить документацию паттерна
   - Effort: Small (1-2 часа)

2. **Создать документацию для Money и Quantity**
   - По аналогии с Ratio (7 файлов)
   - Причина: developer experience
   - Effort: Large (2-3 дня)

### Низкий приоритет (по возможности)

1. **Добавить index.ts в money/rules/**
   - Причина: organizational consistency
   - Effort: Trivial (<30 минут)

2. **Унифицировать errors/index.ts** (добавить везде или убрать из Ratio)
   - Причина: consistency
   - Effort: Trivial (<30 минут)

3. **Решить стратегию LossySerializer**
   - Сделать паттерном ИЛИ документировать как исключение
   - Effort: Small (если паттерн) или Trivial (если документация)

## Action Plan

### Phase 1: Critical Fixes (Week 1)

- [ ] Вынести PriceInvariantViolation в отдельный файл
- [ ] Вынести QuantityInvariantViolation в отдельный файл
- [ ] Обновить импорты и экспорты
- [ ] Запустить тесты для проверки

### Phase 2: Test Coverage (Week 2)

- [ ] Создать MoneyWorkflow.integration.test.ts
- [ ] Покрыть все основные сценарии
- [ ] Достичь >90% coverage для Money

### Phase 3: API Consistency (Week 3)

- [ ] Решить политику экспорта InvariantViolation
- [ ] Реализовать выбранную политику
- [ ] Обновить документацию архитектурного паттерна

### Phase 4: Documentation (Week 4+)

- [ ] Создать docs/money/
- [ ] Создать docs/quantity/
- [ ] Обновить главный README

### Phase 5: Polish (Ongoing)

- [ ] Добавить money/rules/index.ts
- [ ] Унифицировать errors/index.ts
- [ ] Решить стратегию LossySerializer

## Метрики успеха

После выполнения всех рекомендаций:

- ✅ 100% value objects имеют отдельные InvariantViolation файлы
- ✅ 100% value objects имеют integration tests
- ✅ 100% value objects имеют полную документацию
- ✅ Единая политика экспорта InvariantViolation
- ✅ Единообразие структуры Rules и Errors слоев

## Заключение

Обнаруженные несоответствия **не критичны** для функциональности, но влияют на:

- Maintainability
- Developer Experience
- Code consistency
- Documentation quality

Рекомендуется выполнить Phase 1-3 для достижения архитектурной консистентности.

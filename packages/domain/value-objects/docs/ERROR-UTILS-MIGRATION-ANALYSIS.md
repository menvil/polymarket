# Анализ: Куда переместить errorUtils?

## Проблема

`errorUtils.ts` и `ErrorSource.ts` находятся в `packages/domain/value-objects/src/shared/facade/`, но они:

- Используют `@polymarket/result` (foundation layer)
- Используют `@polymarket/errors` (foundation layer)
- Могут быть полезны в других domain пакетах

**Текущие зависимости errorUtils:**

```typescript
import { Result, Ok, Err, isErr } from '@polymarket/result';
import Decimal from 'decimal.js';
import { InvalidMoneyError, ... } from '@polymarket/errors';
import { ErrorSource } from './ErrorSource.js';
```

## Варианты решения

### ❌ Вариант 1: Оставить в value-objects

**Плюсы:**

- Ничего не нужно менять
- Уже работает

**Минусы:**

- ✗ Другие domain пакеты не могут использовать
- ✗ Нарушает архитектурные слои (domain использует foundation, но не должен экспортировать foundation-level утилиты)
- ✗ Логически errorUtils - это не про value objects, а про error handling в целом

**Вердикт:** Неправильное место ❌

---

### ⚠️ Вариант 2: Переместить в @polymarket/result

**Структура:**

```text
packages/foundation/result/src/
├── result.ts                    # Result type
├── ResultChain.ts               # Chaining operations
├── AsyncResultChain.ts          # Async chaining
├── errorUtils.ts                # ← Новое
└── ErrorSource.ts               # ← Новое
```

**Плюсы:**

- ✓ errorUtils тесно связаны с Result<T, E>
- ✓ wrapOp, rewrap возвращают Result
- ✓ Логично иметь утилиты для работы с Result в том же пакете
- ✓ Доступно везде где используется Result

**Минусы:**

- ✗ `@polymarket/result` должен быть чистым, без бизнес-логики
- ✗ Зависимость от `@polymarket/errors` (foundation → foundation, OK)
- ✗ Зависимость от `Decimal` (external dependency в чистом типе)
- ✗ Специфичные для DomainError типы (не generic enough)

**Вердикт:** Возможно, но не идеально ⚠️

---

### ✅ Вариант 3: Переместить в @polymarket/errors

**Структура:**

```text
packages/foundation/errors/src/
├── base/                        # Base error classes
├── math/                        # Math errors
├── value-objects/               # Value object errors
├── errorUtils.ts                # ← Новое
└── ErrorSource.ts               # ← Новое
```

**Плюсы:**

- ✓ ErrorSource enum логично рядом с error классами
- ✓ Утилиты для создания DomainError рядом с DomainError
- ✓ Все что связано с ошибками в одном месте
- ✓ Зависимость от @polymarket/result (foundation → foundation, OK)
- ✓ Зависимость от Decimal (уже есть в errors для math errors)
- ✓ Доступно везде где используются ошибки

**Минусы:**

- ⚠️ `@polymarket/errors` может содержать только типы/классы (но это не строгое правило)
- ⚠️ Утилиты могут выглядеть как "не только ошибки"

**Вердикт:** Лучший вариант! ✅

---

### 🤔 Вариант 4: Новый пакет @polymarket/error-handling

**Структура:**

```text
packages/foundation/error-handling/src/
├── errorUtils.ts
├── ErrorSource.ts
└── index.ts
```

**Плюсы:**

- ✓ Четкое разделение ответственности
- ✓ Может содержать другие error handling утилиты в будущем
- ✓ Не загрязняет существующие пакеты
- ✓ Семантически правильно - отдельный пакет для error handling

**Минусы:**

- ✗ Еще один пакет в монорепе (усложнение)
- ✗ Может быть overkill для ~500 строк кода
- ✗ Нужно настраивать build, exports, tests

**Вердикт:** Хорошо, но пока рано 🤔

---

## Рекомендация: Вариант 3 (@polymarket/errors)

### Почему именно @polymarket/errors?

1. **Семантически правильно:**
   - ErrorSource - это enum для классификации ошибок → логично в @polymarket/errors
   - errorUtils создают и обрабатывают DomainError → логично рядом с DomainError

2. **Архитектурно чисто:**

   ```text
   foundation/errors
   ├── Error classes (InvalidMoneyError, etc)
   ├── ErrorSource enum
   └── errorUtils (создание и обработка ошибок)
   ```

3. **Нет циклических зависимостей:**

   ```text
   @polymarket/errors
   ├── depends on: @polymarket/result ✓
   ├── depends on: decimal.js ✓
   └── used by: все domain пакеты ✓
   ```

4. **Precedents в индустрии:**
   - Java: `java.lang.Error` + `ErrorHandler` utilities в одном пакете
   - Rust: `std::error::Error` + error handling traits вместе
   - Go: `errors` package содержит и типы и утилиты

5. **Практичность:**
   - Один import вместо двух: `import { DomainError, errorUtils } from '@polymarket/errors'`
   - Легко найти все связанное с ошибками в одном месте

### План миграции

#### Phase 1: Подготовка @polymarket/errors

1. Создать директорию `packages/foundation/errors/src/utils/`
2. Переместить `ErrorSource.ts` → `packages/foundation/errors/src/ErrorSource.ts`
3. Переместить `errorUtils.ts` → `packages/foundation/errors/src/utils/errorUtils.ts`
4. Обновить exports в `packages/foundation/errors/src/index.ts`:

   ```typescript
   // Error classes
   export * from './base/index.js';
   export * from './math/index.js';
   export * from './value-objects/index.js';

   // Error handling utilities
   export { ErrorSource } from './ErrorSource.js';
   export * from './utils/errorUtils.js';
   ```

#### Phase 2: Обновление imports в value-objects

Заменить все imports:

```typescript
// Было:
import { errorUtils, ErrorSource } from '../shared/facade/errorUtils.js';

// Стало:
import { errorUtils, ErrorSource } from '@polymarket/errors';
```

Файлы для обновления (~50+ imports):

- All Services (Quote, Price, Quantity, Money, Balance, Spread)
- All Serializers
- All Formatters
- All tests

#### Phase 3: Удаление старых файлов

```bash
rm packages/domain/value-objects/src/shared/facade/errorUtils.ts
rm packages/domain/value-objects/src/shared/facade/ErrorSource.ts
```

#### Phase 4: Тестирование

```bash
# Сначала errors пакет
cd packages/foundation/errors
npm run build
npm test

# Потом value-objects
cd packages/domain/value-objects
npm run build
npm test

# Весь монореп
cd ../../..
npm run build
npm test
```

### Альтернативный план (если хочется начать с малого)

Можно начать с **промежуточного шага**:

1. Переместить только `ErrorSource.ts` в `@polymarket/errors` (он точно туда относится)
2. Оставить `errorUtils.ts` пока в value-objects
3. В будущем, когда появится второй domain пакет, который хочет использовать errorUtils - тогда переместить

## Итоговое решение

### ✅ Рекомендую: @polymarket/errors

Это семантически правильное, архитектурно чистое и практичное решение.

**Timing:**

- Если планируешь добавлять другие domain пакеты скоро → мигрируй сейчас
- Если value-objects единственный domain пакет → можно отложить до появления второго

**Альтернатива:**

- Если в будущем error handling разрастется (circuit breakers, retry policies, error tracking) → создать отдельный `@polymarket/error-handling` пакет

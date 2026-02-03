# План унификации Error Handling: !result.ok → isErr()

**Дата:** 2026-02-03
**Статус:** Proposed
**Цель:** Унифицировать все value objects на единый паттерн `isErr()` для consistency

---

## 🎯 Зачем это нужно?

### Текущая ситуация

| Module | Pattern | Status |
|--------|---------|--------|
| **Percentage** | `isErr()` | ✅ Best practice |
| **Money** | `!result.ok` | 🟡 Работает, но inconsistent |
| **Price** | `!result.ok` | 🟡 Работает, но inconsistent |
| **Quantity** | `!result.ok` | 🟡 Работает, но inconsistent |
| **Balance** | `!result.ok` | 🟡 Работает, но inconsistent |
| **Quote** | `!result.ok` | 🟡 Работает, но inconsistent |
| **Spread** | `!result.ok` | 🟡 Работает, но inconsistent |

### Преимущества унификации

1. **Consistency** - единый стиль во всем codebase
2. **Explicit semantics** - `isErr()` явно показывает намерение
3. **Foundation alignment** - используем utilities из `@polymarket/result`
4. **Better IDE support** - явный type predicate в tooltips
5. **Backwards compatibility** - работает на любой версии TypeScript
6. **Easier onboarding** - новые разработчики видят единый паттерн

---

## 📊 Масштаб изменений

### Анализ использования

```bash
# Количество использований !result.ok в каждом модуле
```

| Module | Files | Occurrences | Estimated Lines Changed |
|--------|-------|-------------|------------------------|
| Money | 1 (MoneyService.ts) | 5 | ~5 |
| Price | 1 (PriceService.ts) | 10 | ~10 |
| Quantity | 1 (QuantityService.ts) | 7 | ~7 |
| Balance | 1 (BalanceService.ts) | 6 | ~6 |
| Quote | 1 (QuoteService.ts) | 8 | ~8 |
| Spread | 1 (SpreadService.ts) | 5 | ~5 |
| **TOTAL** | **6 files** | **41 occurrences** | **~41 lines** |

### Затронутые файлы

```
packages/domain/value-objects/src/
├── money/facade/MoneyService.ts        (5 замен)
├── price/facade/PriceService.ts        (10 замен)
├── quantity/facade/QuantityService.ts  (7 замен)
├── balance/facade/BalanceService.ts    (6 замен)
├── quote/facade/QuoteService.ts        (8 замен)
└── spread/facade/SpreadService.ts      (5 замен)
```

---

## 🗓️ Поэтапный план

### Phase 1: Money (1-2 часа)

#### Шаг 1.1: Добавить import

```diff
// src/money/facade/MoneyService.ts
- import { Result, Ok, Err } from '@polymarket/result';
+ import { Result, Ok, Err, isErr } from '@polymarket/result';
```

#### Шаг 1.2: Заменить все вхождения

**Найдено 5 использований `!result.ok`:**

1. **Line 95 - create()**
```diff
const decimalResult = toDecimal('value', value, MoneyErrorReason.INVALID_FORMAT, InvalidMoneyError);
- if (!decimalResult.ok) {
+ if (isErr(decimalResult)) {
  return Err(rewrap('create', { currency }, decimalResult.error, InvalidMoneyError));
}
```

2. **Line 306 - multiply()**
```diff
const factorResult = toDecimal('factor', factor, MoneyErrorReason.INVALID_FORMAT, InvalidMoneyError);
- if (!factorResult.ok) {
+ if (isErr(factorResult)) {
  return Err(rewrap('multiply', ctx, factorResult.error, InvalidMoneyError));
}
```

3. **Line 320 - multiply() validation**
```diff
const validateResult = ValidateFactorForMoneyMultiplication.check(factorResult.value);
- if (!validateResult.ok) {
+ if (isErr(validateResult)) {
  return Err(rewrap('multiply', ctx, validateResult.error, InvalidMoneyError));
}
```

4. **Line 377 - divide()**
```diff
const divisorResult = toDecimal('divisor', divisor, MoneyErrorReason.INVALID_FORMAT, InvalidMoneyError);
- if (!divisorResult.ok) {
+ if (isErr(divisorResult)) {
  return Err(rewrap('divide', ctx, divisorResult.error, InvalidMoneyError));
}
```

5. **Line 391 - divide() validation**
```diff
const validateResult = ValidateDivisorForMoneyDivision.check(divisorResult.value);
- if (!validateResult.ok) {
+ if (isErr(validateResult)) {
  return Err(rewrap('divide', ctx, validateResult.error, InvalidMoneyError));
}
```

#### Шаг 1.3: Обновить TSDoc примеры

В комментариях также используется `!result.ok` в примерах. Обновить для consistency:

```diff
/**
 * @example
 * ```typescript
 * const result = MoneyService.create('invalid');
- * if (!result.ok) {
+ * if (isErr(result)) {
 *   console.error(result.error);
 * }
 * ```
 */
```

**Найдено в MoneyService.ts:** ~3 примера в комментариях

#### Шаг 1.4: Verification

```bash
# Type check
npx tsc --noEmit src/money/facade/MoneyService.ts

# Lint
npm run lint

# Tests
npm test -- money

# Full CI
npm run ci
```

**Expected:** ✅ Все проверки проходят

---

### Phase 2: Price (2-3 часа)

#### Complexity: Medium

Price имеет больше использований (10) из-за дополнительных методов:
- `alignToTickSize()` - 4 использования
- `roundToTickSize()` - 2 использования
- Standard methods - 4 использования

#### Шаг 2.1: Добавить import

```diff
// src/price/facade/PriceService.ts
- import { Result, Ok, Err } from '@polymarket/result';
+ import { Result, Ok, Err, isErr } from '@polymarket/result';
```

#### Шаг 2.2: Заменить все вхождения (10 замен)

**Group 1: Standard methods (4)**
- Line 99 - create()
- Line 221 - multiply()
- Line 234 - multiply() validation
- Line 291 - divide()
- Line 304 - divide() validation

**Group 2: alignToTickSize() (4)**
- Line 371 - toDecimal для tickSize
- Line 383 - ValidateTickSize check
- Line ~390 - ValidateTickSizeMultipleOfBaseTick check
- Line ~400 - aligned result check

**Group 3: roundToTickSize() (2)**
- Line 455 - toDecimal для tickSize
- Line 466 - ValidateTickSize check
- Line 479 - rounded result check

#### Шаг 2.3: Обновить комментарии (~2 примера)

#### Шаг 2.4: Verification

```bash
npx tsc --noEmit src/price/facade/PriceService.ts
npm test -- price
npm run ci
```

---

### Phase 3: Quantity (1-2 часа)

#### Шаг 3.1: Добавить import

```diff
// src/quantity/facade/QuantityService.ts
- import { Result, Ok, Err } from '@polymarket/result';
+ import { Result, Ok, Err, isErr } from '@polymarket/result';
```

#### Шаг 3.2: Заменить все вхождения (7 замен)

**Найдено 7 использований:**
1. Line 69 - create()
2. Line 169 - add() validation
3. Line 204 - multiply()
4. Line 217 - multiply() validation
5. Line 278 - divide()
6. Line 291 - divide() validation
7. Line 347 - alignToStepSize()
8. Line 360 - alignToStepSize() validation

#### Шаг 3.3: Обновить комментарии (~2 примера)

#### Шаг 3.4: Verification

```bash
npx tsc --noEmit src/quantity/facade/QuantityService.ts
npm test -- quantity
npm run ci
```

---

### Phase 4: Balance (1-2 часа)

#### Шаг 4.1: Добавить import

```diff
// src/balance/facade/BalanceService.ts
- import { Result, Ok, Err } from '@polymarket/result';
+ import { Result, Ok, Err, isErr } from '@polymarket/result';
```

#### Шаг 4.2: Заменить все вхождения (6 замен)

**Найдено 6 использований:**
1. reserve() - validation check
2. release() - validation check
3. add() - currency match check
4. subtract() - currency match check
5. multiply() - factor validation
6. divide() - divisor validation

#### Шаг 4.3: Verification

```bash
npx tsc --noEmit src/balance/facade/BalanceService.ts
npm test -- balance
npm run ci
```

---

### Phase 5: Quote (2-3 часа)

#### Complexity: High

Quote - самый сложный модуль с большим количеством validations.

#### Шаг 5.1: Добавить import

```diff
// src/quote/facade/QuoteService.ts
- import { Result, Ok, Err } from '@polymarket/result';
+ import { Result, Ok, Err, isErr } from '@polymarket/result';
```

#### Шаг 5.2: Заменить все вхождения (8 замен)

**Найдено 8 использований:**
1. create() - ValidateMarketCrossing
2. create() - ValidateQuoteSizes
3. create() - ValidateMinSpread
4. create() - ValidateMaxSpread
5. updateBid() - validation
6. updateAsk() - validation
7. adjustSpread() - validation 1
8. adjustSpread() - validation 2

#### Шаг 5.3: Verification

```bash
npx tsc --noEmit src/quote/facade/QuoteService.ts
npm test -- quote
npm run ci
```

---

### Phase 6: Spread (1 час)

#### Шаг 6.1: Добавить import

```diff
// src/spread/facade/SpreadService.ts
- import { Result, Ok, Err } from '@polymarket/result';
+ import { Result, Ok, Err, isErr } from '@polymarket/result';
```

#### Шаг 6.2: Заменить все вхождения (5 замен)

**Найдено 5 использований:**
1. create() - ValidateBidAsk
2. create() - ValidateMinWidth
3. create() - ValidateMaxWidth
4. widen() - validation
5. narrow() - validation

#### Шаг 6.3: Verification

```bash
npx tsc --noEmit src/spread/facade/SpreadService.ts
npm test -- spread
npm run ci
```

---

### Phase 7: Final Verification (30 минут)

#### Шаг 7.1: Full type check

```bash
npm run typecheck:all
```

**Expected:** ✅ 0 errors

#### Шаг 7.2: Full lint

```bash
npm run lint:all
```

**Expected:** ✅ 0 errors, 0 warnings

#### Шаг 7.3: Full build

```bash
npm run build
```

**Expected:** ✅ dist/ generated successfully

#### Шаг 7.4: Full test suite

```bash
npm run test:coverage
```

**Expected:**
- ✅ All 48 test suites pass
- ✅ 879+ tests pass
- ✅ Coverage remains same or better

#### Шаг 7.5: Complete CI

```bash
npm run ci:full
```

**Expected:** ✅ Exit code 0

---

## 🔧 Автоматизация

### Опция 1: Manual (Recommended)

**Плюсы:**
- ✅ Полный контроль
- ✅ Review каждого изменения
- ✅ Обучение архитектуре

**Минусы:**
- ⏱️ Занимает больше времени (~8-12 часов)

### Опция 2: Script-assisted

Создать скрипт для автоматизации замен:

```bash
#!/bin/bash
# scripts/refactor-to-isErr.sh

FILES=(
  "src/money/facade/MoneyService.ts"
  "src/price/facade/PriceService.ts"
  "src/quantity/facade/QuantityService.ts"
  "src/balance/facade/BalanceService.ts"
  "src/quote/facade/QuoteService.ts"
  "src/spread/facade/SpreadService.ts"
)

for file in "${FILES[@]}"; do
  echo "Processing $file..."

  # 1. Add isErr import
  sed -i '' 's/import { Result, Ok, Err }/import { Result, Ok, Err, isErr }/g' "$file"

  # 2. Replace !result.ok with isErr(result)
  # Это сложнее - требует более умного парсинга
  # Рекомендуется делать вручную
done
```

**⚠️ Предупреждение:**
- Regex замены могут быть опасны
- Могут сломать форматирование
- Могут пропустить edge cases
- **Рекомендуется manual approach**

### Опция 3: TypeScript Code Mod

Использовать `ts-morph` для AST-based трансформации:

```typescript
// scripts/refactor-to-isErr.ts
import { Project, SyntaxKind } from 'ts-morph';

const project = new Project({
  tsConfigFilePath: 'tsconfig.json'
});

const files = [
  'src/money/facade/MoneyService.ts',
  'src/price/facade/PriceService.ts',
  // ... и т.д.
];

files.forEach(filePath => {
  const sourceFile = project.getSourceFile(filePath);

  // 1. Add isErr import
  const resultImport = sourceFile.getImportDeclaration('@polymarket/result');
  const namedImports = resultImport?.getNamedImports();
  if (namedImports && !namedImports.find(i => i.getName() === 'isErr')) {
    resultImport?.addNamedImport('isErr');
  }

  // 2. Find and replace !result.ok patterns
  sourceFile.getDescendantsOfKind(SyntaxKind.PrefixUnaryExpression)
    .filter(node => {
      return node.getOperatorToken() === SyntaxKind.ExclamationToken &&
             node.getOperand().getText().endsWith('.ok');
    })
    .forEach(node => {
      const resultVar = node.getOperand().getText().replace('.ok', '');
      node.replaceWithText(`isErr(${resultVar})`);
    });

  sourceFile.saveSync();
});
```

**Запуск:**
```bash
npm install --save-dev ts-morph
npx ts-node scripts/refactor-to-isErr.ts
```

**Плюсы:**
- ✅ AST-based - безопасно
- ✅ Сохраняет форматирование
- ✅ Точные замены

**Минусы:**
- ⚠️ Требует настройки ts-morph
- ⚠️ Нужно тестировать скрипт

---

## 📋 Checklist для каждого модуля

### Pre-refactoring

- [ ] Убедись что все тесты проходят
- [ ] Создай feature branch: `git checkout -b refactor/unify-error-handling`
- [ ] Запомни baseline coverage: `npm run test:coverage`

### During refactoring

- [ ] Добавь `isErr` в import
- [ ] Замени все `!result.ok` → `isErr(result)`
- [ ] Обновi TSDoc примеры в комментариях
- [ ] Запусти typecheck для файла
- [ ] Запусти lint для файла

### Post-refactoring

- [ ] Запусти тесты модуля: `npm test -- <module>`
- [ ] Проверь что все тесты проходят
- [ ] Проверь coverage не снизился
- [ ] Запусти `npm run ci`
- [ ] Создай коммит с описанием

### Final

- [ ] Запусти `npm run ci:full`
- [ ] Проверь что все 48 suites проходят
- [ ] Проверь что coverage >= baseline
- [ ] Создай Pull Request
- [ ] Request review

---

## 🎯 Рекомендуемый порядок выполнения

### Вариант 1: По одному модулю (Recommended)

**День 1:**
1. Money (утро) - 1-2 часа
2. Quantity (день) - 1-2 часа
3. Spread (вечер) - 1 час

**День 2:**
4. Balance (утро) - 1-2 часа
5. Price (день) - 2-3 часа

**День 3:**
6. Quote (утро-день) - 2-3 часа
7. Final Verification (вечер) - 30 минут

**Total:** 8-12 часов (3 дня)

### Вариант 2: Parallel (если команда)

**Developer 1:**
- Money + Quantity + Spread (4-5 часов)

**Developer 2:**
- Balance + Price (3-5 часов)

**Developer 3:**
- Quote (2-3 часа)

**Together:**
- Final Verification + Merge

**Total:** 1 день (параллельно)

---

## 🔍 Тестирование

### Unit Tests

После каждого модуля:
```bash
npm test -- <module-name>
```

**Expected:** ✅ Все тесты модуля проходят

### Integration Tests

После всех изменений:
```bash
npm test -- --testPathPattern=integration
```

**Expected:** ✅ Все integration тесты проходят

### Regression Testing

Особое внимание на:
- Error handling paths
- Validation logic
- Type narrowing в conditional branches

### Coverage Verification

```bash
npm run test:coverage
```

**Expected:**
- ✅ Coverage не снизился
- ✅ Все критические paths покрыты

---

## 📝 Commit Strategy

### Опция 1: One commit per module

```bash
git commit -m "refactor(money): unify error handling to isErr() pattern"
git commit -m "refactor(price): unify error handling to isErr() pattern"
# ... и т.д.
```

**Плюсы:**
- ✅ Легко review по модулям
- ✅ Легко revert отдельный модуль
- ✅ Понятная история изменений

### Опция 2: Grouped commits

```bash
git commit -m "refactor: unify error handling in simple modules (money, quantity, spread)"
git commit -m "refactor: unify error handling in complex modules (balance, price, quote)"
```

### Опция 3: Single commit (Not recommended)

```bash
git commit -m "refactor: unify all value objects to isErr() pattern"
```

**Минусы:**
- ❌ Сложно review
- ❌ Сложно найти проблемы
- ❌ Невозможно partial revert

---

## ⚠️ Риски и митигация

### Риск 1: Сломать существующий функционал

**Вероятность:** Low (изменения механические)

**Митигация:**
- ✅ Comprehensive test suite уже есть
- ✅ CI проверяет каждый коммит
- ✅ Manual review каждого изменения
- ✅ Поэтапный подход

### Риск 2: Пропустить некоторые вхождения

**Вероятность:** Medium (если использовать автоматизацию)

**Митигация:**
- ✅ Grep проверка после рефакторинга:
  ```bash
  grep -r "!.*\.ok" src/*/facade/*.ts
  # Should return 0 results после завершения
  ```
- ✅ Manual review каждого файла
- ✅ TypeScript catch missing changes

### Риск 3: Время выполнения

**Вероятность:** Medium (8-12 часов работы)

**Митигация:**
- ✅ Можно делать параллельно (если команда)
- ✅ Можно растянуть на несколько дней
- ✅ Низкая приоритет - не блокирует другую работу

### Риск 4: Merge conflicts

**Вероятность:** High (если другие изменения в тех же файлах)

**Митигация:**
- ✅ Координация с командой
- ✅ Feature freeze на время рефакторинга
- ✅ Или делать после release

---

## 📊 Metrics для отслеживания

### Before refactoring

```bash
# Сколько использований !result.ok
grep -r "!.*\.ok" src/*/facade/*.ts | wc -l
# Expected: ~41

# Сколько использований isErr
grep -r "isErr" src/*/facade/*.ts | wc -l
# Expected: ~8 (только Percentage)
```

### After refactoring

```bash
# Сколько использований !result.ok
grep -r "!.*\.ok" src/*/facade/*.ts | wc -l
# Expected: 0

# Сколько использований isErr
grep -r "isErr" src/*/facade/*.ts | wc -l
# Expected: ~49 (41 новых + 8 существующих)
```

### Test coverage

```bash
npm run test:coverage
```

**Before:**
- Statements: X%
- Branches: Y%
- Functions: Z%
- Lines: W%

**After:**
- Statements: >= X%
- Branches: >= Y%
- Functions: >= Z%
- Lines: >= W%

---

## 🎓 Learning Outcomes

После завершения рефакторинга команда будет:

1. **Понимать архитектуру** всех value objects
2. **Знать error handling patterns** в деталях
3. **Уметь использовать** foundation utilities
4. **Видеть consistency** во всем codebase
5. **Применять best practices** автоматически

---

## 📈 Post-refactoring

### Documentation updates

После завершения обновить:
- [ ] docs/development/coding-guidelines.md
  - Добавить правило: "Always use isErr() for error checking"
- [ ] docs/examples/*.md
  - Обновить все примеры на isErr()
- [ ] README.md
  - Обновить Quick Start примеры

### Team communication

- [ ] Announce в team chat
- [ ] Update coding standards doc
- [ ] Onboarding materials update
- [ ] Code review checklist update

---

## 🔗 Related Documents

- [TypeScript 5.9 Improvements](../analysis/typescript-5.9-improvements.md)
- [Type Safety Investigation](../analysis/type-safety-investigation.md)
- [CI/CD Integration](../development/ci-cd-integration.md)
- [Percentage Quality Assessment](../analysis/percentage-quality-assessment.md)

---

## 📋 Final Checklist

### Preparation
- [ ] Team alignment on refactoring
- [ ] Schedule time allocation
- [ ] Create feature branch
- [ ] Baseline metrics collected

### Execution
- [ ] Money refactored
- [ ] Price refactored
- [ ] Quantity refactored
- [ ] Balance refactored
- [ ] Quote refactored
- [ ] Spread refactored

### Verification
- [ ] All type checks pass
- [ ] All lint checks pass
- [ ] All tests pass (879+ tests)
- [ ] Coverage >= baseline
- [ ] `npm run ci:full` passes

### Finalization
- [ ] Documentation updated
- [ ] PR created and reviewed
- [ ] Merged to main
- [ ] Team notified
- [ ] Coding guidelines updated

---

**Автор:** Claude Code
**Дата:** 2026-02-03
**Версия:** 1.0
**Статус:** Proposed - Ready for Implementation
**Estimated Effort:** 8-12 hours (solo) or 1 day (team of 3)

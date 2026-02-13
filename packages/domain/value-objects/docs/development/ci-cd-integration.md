# CI/CD Integration Guide

**Дата:** 2026-02-03
**Статус:** Active
**Phase:** 1 - CI/CD Protection

---

## 📋 Обзор

Руководство по интеграции type checking и других проверок в CI/CD pipeline.

---

## 🎯 Доступные CI Scripts

### npm run ci

**Базовая проверка для pull requests:**

```bash
npm run ci
```

Выполняет в строгой последовательности:

1. `typecheck` - проверка типов TypeScript
2. `lint` - проверка code style (ESLint)
3. `build` - компиляция проекта
4. `test` - запуск тестов

**Когда использовать:**

- ✅ Pre-commit hooks
- ✅ Pull request validation
- ✅ Quick CI checks

**Время выполнения:** ~30-60 секунд

---

### npm run ci:full

**Полная проверка для release:**

```bash
npm run ci:full
```

Выполняет в строгой последовательности:

1. `typecheck:all` - проверка типов src + tests
2. `lint:all` - проверка code style src + tests
3. `build` - компиляция проекта
4. `test:coverage` - тесты с coverage отчетом

**Когда использовать:**

- ✅ Pre-release validation
- ✅ Main branch protection
- ✅ Nightly builds
- ✅ Coverage reports

**Время выполнения:** ~60-120 секунд

---

## 🔍 Что проверяется

### 1. Type Checking (typecheck)

```bash
npm run typecheck
```

**Проверяет:**

- ✅ TypeScript type errors в src/
- ✅ Правильность использования generic типов
- ✅ Type narrowing в Result<T, E>
- ✅ Соответствие interfaces и types

**НЕ проверяет:**

- ❌ Тесты (для этого используй `typecheck:all`)

**Выход:**

- Exit code 0 - все ОК
- Exit code != 0 - есть type errors

**Пример ошибки:**

```text
src/money/facade/MoneyService.ts(97,63): error TS2339:
  Property 'error' does not exist on type 'Result<Decimal, InvalidMoneyError>'.
```

---

### 2. Linting (lint)

```bash
npm run lint
```

**Проверяет:**

- ✅ ESLint rules
- ✅ Code style consistency
- ✅ Best practices violations
- ✅ Unused imports

**Автофикс:**

```bash
npm run lint:fix
```

---

### 3. Build (build)

```bash
npm run build
```

**Проверяет:**

- ✅ Успешная компиляция TypeScript
- ✅ Генерация .d.ts declaration files
- ✅ Отсутствие circular dependencies

**Результат:**

- Генерирует `dist/` директорию
- Создает declaration maps для IDE

---

### 4. Tests (test)

```bash
npm run test
```

**Запускает:**

- ✅ Все unit тесты (**tests**/)
- ✅ Integration тесты
- ✅ Snapshot тесты

**С coverage:**

```bash
npm run test:coverage
```

Генерирует отчет в `coverage/`

---

## ⚙️ GitHub Actions Integration

### Pull Request Workflow

```yaml
# .github/workflows/pr-validation.yml
name: PR Validation

on:
  pull_request:
    branches: [main, develop]

jobs:
  validate:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run CI checks
        run: npm run ci
        working-directory: packages/domain/value-objects
```

---

### Main Branch Protection

```yaml
# .github/workflows/main-validation.yml
name: Main Branch Validation

on:
  push:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run full CI checks
        run: npm run ci:full
        working-directory: packages/domain/value-objects

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: ./packages/domain/value-objects/coverage/lcov.info
```

---

## 🔧 GitLab CI Integration

### .gitlab-ci.yml

```yaml
stages:
  - validate
  - build
  - test

variables:
  NODE_VERSION: "20"

# Pull Request Validation
validate:pr:
  stage: validate
  image: node:${NODE_VERSION}
  only:
    - merge_requests
  script:
    - cd packages/domain/value-objects
    - npm ci
    - npm run ci
  cache:
    key: ${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/

# Main Branch Full Check
validate:main:
  stage: validate
  image: node:${NODE_VERSION}
  only:
    - main
  script:
    - cd packages/domain/value-objects
    - npm ci
    - npm run ci:full
  artifacts:
    reports:
      coverage_report:
        coverage_format: cobertura
        path: packages/domain/value-objects/coverage/cobertura-coverage.xml
  cache:
    key: ${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/
```

---

## 🪝 Pre-commit Hooks

### Using Husky

```bash
# Установка
npm install --save-dev husky

# Инициализация
npx husky init
```

### .husky/pre-commit

```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

# Run CI checks before commit
cd packages/domain/value-objects
npm run typecheck && npm run lint && npm test
```

**Рекомендация:** Для быстрых коммитов используй только `typecheck + lint`:

```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

cd packages/domain/value-objects
npm run typecheck && npm run lint
```

---

## 📊 Monitoring

### Success Criteria

**Pull Request должен:**

- ✅ Пройти `npm run ci` с exit code 0
- ✅ Иметь 0 TypeScript errors
- ✅ Иметь 0 ESLint errors
- ✅ Все тесты pass
- ✅ Coverage не снижается

### Failure Actions

**Если CI падает:**

1. **Type errors:**

   ```bash
   npm run typecheck
   # Исправь ошибки в выводе
   ```

2. **Lint errors:**

   ```bash
   npm run lint:fix
   # Review изменения
   git add .
   ```

3. **Test failures:**

   ```bash
   npm test
   # Исправь failed тесты
   ```

4. **Build errors:**

   ```bash
   npm run build
   # Проверь circular dependencies
   ```

---

## 🎯 Best Practices

### 1. Local First

**ВСЕГДА запускай проверки локально перед push:**

```bash
npm run ci
```

Это сэкономит время CI/CD и быстрее выявит проблемы.

---

### 2. Incremental Checks

**Для быстрой разработки используй watch mode:**

```bash
# Terminal 1: TypeScript watch
npm run build:watch

# Terminal 2: Test watch
npm run test:watch
```

---

### 3. Pre-Push Validation

**Создай алиас для быстрой проверки:**

```bash
# В package.json
{
  "scripts": {
    "pre-push": "npm run typecheck && npm run lint && npm test"
  }
}
```

```bash
# Перед push
npm run pre-push
```

---

## 🚨 Troubleshooting

### "typecheck passes locally but fails in CI"

**Причина:** Разные версии TypeScript или node_modules

**Решение:**

```bash
# Очисти и переустанови dependencies
rm -rf node_modules package-lock.json
npm install

# Проверь версию TypeScript
npx tsc --version  # Должно быть 5.9.3+
```

---

### "Build succeeds but runtime errors"

**Причина:** TypeScript генерирует JS даже с type errors (по умолчанию)

**Решение:**

- ✅ CI script запускает `typecheck` ПЕРЕД build
- ✅ Если typecheck падает - build не запустится
- ✅ Это гарантирует type safety

---

### "Tests pass locally but fail in CI"

**Причина:** Временные зависимости или порядок выполнения

**Решение:**

```bash
# Запусти тесты в случайном порядке
npm test -- --randomize

# Проверь изоляцию тестов
npm test -- --runInBand
```

---

## 📈 Metrics

### Рекомендуемые метрики для отслеживания

1. **Type Safety:**
   - 0 TypeScript errors на main branch
   - 0 `// @ts-ignore` в production code

2. **Code Quality:**
   - 0 ESLint errors
   - < 5 ESLint warnings

3. **Test Coverage:**
   - \> 80% line coverage
   - \> 70% branch coverage
   - \> 80% function coverage

4. **Build Time:**
   - CI run < 2 minutes для PR
   - Full CI < 5 minutes для main

---

## 🔗 Related Documents

- [Type Safety Investigation](../analysis/type-safety-investigation.md)
- [Development Guidelines](./typescript-config.md)
- [Testing Guide](./testing-guide.md)

---

## 📝 Changelog

### 2026-02-03 - Phase 1 Complete

- ✅ Добавлены `ci` и `ci:full` scripts
- ✅ Созданы примеры для GitHub Actions
- ✅ Созданы примеры для GitLab CI
- ✅ Добавлена документация по pre-commit hooks
- ✅ Описаны best practices

---

**Автор:** Claude Code
**Версия:** 1.0
**Статус:** Production Ready

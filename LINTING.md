# Linting Strategy для Polymarket Monorepo

## 🎯 Цель

Обеспечить единообразие кода во всех пакетах проекта с возможностью кастомизации для отдельных пакетов.

## 📁 Структура конфигураций

```
polymarket/
├── .editorconfig           # Общие настройки редактора для всего проекта
├── .eslintrc.base.json     # Базовая ESLint конфигурация
└── packages/
    └── foundation/
        ├── types/
        │   ├── .eslintrc.json      # Наследует .eslintrc.base.json + свои правила
        │   └── .editorconfig       # (опционально) Переопределяет настройки
        └── errors/
            └── .eslintrc.json      # Наследует .eslintrc.base.json + свои правила
```

## 🔧 Базовые правила (применяются ко всем пакетам)

### EditorConfig (`.editorconfig`)
- ✅ `insert_final_newline = true` - обязательный перевод строки в конце файла
- ✅ `end_of_line = lf` - Unix-style переводы строк
- ✅ `charset = utf-8` - кодировка UTF-8
- ✅ `trim_trailing_whitespace = true` - удаление пробелов в конце строк

### ESLint (`.eslintrc.base.json`)
- ✅ `eol-last: ["error", "always"]` - обязательная новая строка в конце файла
- ✅ `no-trailing-spaces: "error"` - запрет пробелов в конце строк
- ✅ `no-multiple-empty-lines: ["error", { "max": 1, "maxEOF": 0 }]` - не более 1 пустой строки
- ⚠️ `@typescript-eslint/no-explicit-any: "warn"` - предупреждение при использовании any
- ✅ Игнорирование неиспользуемых переменных с префиксом `_`

## 📦 Настройка для нового пакета

### Шаг 1: Создать `.eslintrc.json` в пакете

```json
{
  "root": true,
  "extends": ["../../.eslintrc.base.json"],
  "parserOptions": {
    "project": "./tsconfig.eslint.json"
  },
  "rules": {
    // Здесь можно переопределить или добавить правила специфичные для пакета
  }
}
```

### Шаг 2: Добавить npm scripts в `package.json`

```json
{
  "scripts": {
    "lint": "eslint src --ext .ts",
    "lint:fix": "eslint src --ext .ts --fix",
    "lint:tests": "eslint __tests__ --ext .ts",
    "lint:tests:fix": "eslint __tests__ --ext .ts --fix",
    "lint:all": "eslint src __tests__ --ext .ts",
    "lint:all:fix": "eslint src __tests__ --ext .ts --fix"
  }
}
```

### Шаг 3: (Опционально) Создать `.editorconfig` для специфичных настроек

Если нужно переопределить настройки только для этого пакета:

```ini
# НЕ указывайте root = true!
[*.ts]
indent_size = 4  # Пример переопределения
```

## 🚀 Использование

### Проверка кода
```bash
npm run lint          # Проверить src
npm run lint:all      # Проверить src + tests
```

### Автоматическое исправление
```bash
npm run lint:fix      # Исправить src
npm run lint:all:fix  # Исправить всё
```

## 🔄 Применение изменений ко всем пакетам

### Автоматический способ (Рекомендуется)

Используйте скрипт для линтинга всех пакетов:

```bash
# Из корня проекта

# Проверка (только показывает ошибки)
./scripts/lint-all-packages.sh

# Автоматическое исправление
./scripts/lint-all-packages.sh --fix
```

Скрипт автоматически:
- Находит все пакеты в монорепо
- Запускает линтинг для каждого пакета
- Показывает сводку результатов
- Возвращает ненулевой код выхода при ошибках

### Ручной способ

Если нужно линтить конкретные пакеты:

```bash
# Из корня проекта
cd packages/foundation/types && npm run lint:all:fix
cd ../errors && npm run lint:all:fix
# ... для остальных пакетов
```

## 📋 Чеклист для новых пакетов

- [ ] Создан `.eslintrc.json` с `extends: ["../../.eslintrc.base.json"]`
- [ ] Добавлены npm scripts для линтинга
- [ ] Запущен `npm run lint:all:fix` для исправления ошибок
- [ ] Проверено, что все файлы заканчиваются новой строкой
- [ ] EditorConfig корректно работает в вашем редакторе

## 🎨 Рекомендации

1. **Не дублируйте правила** - если правило уже есть в `.eslintrc.base.json`, не повторяйте его в пакете
2. **Используйте EditorConfig** - большинство редакторов автоматически применят настройки
3. **Запускайте `lint:fix` перед коммитом** - автоматически исправит многие проблемы
4. **Добавляйте правила в base config осторожно** - это влияет на все пакеты

## 🔧 Поддерживаемые редакторы

- ✅ VS Code - встроенная поддержка EditorConfig
- ✅ WebStorm/IntelliJ IDEA - встроенная поддержка
- ✅ Vim/Neovim - плагин editorconfig-vim
- ✅ Sublime Text - плагин EditorConfig
- ✅ Atom - плагин editorconfig

## 📚 Дополнительные ресурсы

- [EditorConfig Documentation](https://editorconfig.org/)
- [ESLint Configuration](https://eslint.org/docs/user-guide/configuring/)
- [TypeScript ESLint](https://typescript-eslint.io/)
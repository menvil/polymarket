# Архитектура Side Value Object

## Почему type alias, а не class

Side реализован как `type Side = 'BUY' | 'SELL'` — string literal union, а не class с private constructor.

**Аргументы в пользу type alias:**

| Критерий | Side (type alias) | Balance (class) |
|---|---|---|
| Внутреннее состояние | Нет (примитивная строка) | Есть (available + reserved) |
| Инварианты внутри значения | Нет | Есть (available >= 0, etc.) |
| Нужен Decimal.js или обёртка | Нет | Нет, но Money — да |
| Private constructor | Не нужен | Нужен для защиты |
| Сравнение | `===` | Кастомный equals() |

Инварианты Side (допустимые значения) защищаются на уровне фасада через `isValidSide()` и `fromString`/`fromUnknown`, а не через конструктор.

**Результат:** Side — это просто строка с compile-time и runtime гарантиями допустимых значений. Никакого overhead от создания объектов.

## Структура пакета

```text
side/
├── core/
│   └── Side.ts          # type Side, ALL_SIDES, SIDE_SET, isValidSide, утилиты
├── facade/
│   └── SideService.ts   # публичный API (fromString, fromUnknown, opposite, ...)
├── adapters/
│   ├── SideSerializer.ts # JSON сериализация/десериализация
│   └── SideFormatter.ts  # UI форматирование
└── errors/
    └── SideErrorReason.ts # INVALID_VALUE | INVALID_TYPE
```

## ALL_SIDES как единственный источник правды

`ALL_SIDES` — замороженный массив, от которого производны все остальные механизмы валидации.

```typescript
// core/Side.ts

// Единственный источник правды — заморожен для runtime-иммутабельности
export const ALL_SIDES: readonly Side[] = Object.freeze(['BUY', 'SELL']) as readonly Side[];

// SIDE_SET — производный, строится один раз при загрузке модуля
// Не экспортируется — внутренний модуль
const SIDE_SET = new Set<string>(ALL_SIDES);

// Type guard использует SIDE_SET для O(1) lookup
// Добавление нового значения в ALL_SIDES автоматически обновляет эту функцию
export function isValidSide(value: unknown): value is Side {
  return typeof value === 'string' && SIDE_SET.has(value);
}
```

**Почему `Object.freeze`:** попытка `(ALL_SIDES as any).push('FOO')` бросит `TypeError` в strict mode. Это защита от случайной мутации в runtime — TypeScript гарантирует `readonly` только на уровне типов.

**Почему `SIDE_SET` не экспортируется:** это деталь реализации. Внешний код должен использовать `isValidSide()` или `SideService.isValid()`, а не напрямую обращаться к Set.

**Почему `ALL_SIDES` (без spread) в ошибках:** поскольку `ALL_SIDES` заморожен через `Object.freeze`, его безопасно передавать по ссылке без лишних аллокаций. Спред `[...ALL_SIDES]` создавал бы новый массив при каждом броске — это излишне, когда исходный массив уже иммутабелен.

```typescript
// parseSideOrThrow — использует ALL_SIDES напрямую (уже заморожен, лишние аллокации не нужны)
throw new InvalidSideError(
  (ctx) => `Invalid side value: ${ctx.value}. Expected ${ALL_SIDES.join(' or ')}`,
  {
    context: {
      expectedValues: ALL_SIDES, // frozen array — safe to share directly
      reason: SideErrorReason.INVALID_VALUE,
    },
  }
);
```

## Семантика INVALID_TYPE vs INVALID_VALUE

Enum `SideErrorReason` содержит два значения с чёткими границами:

### INVALID_TYPE

Возникает когда runtime-значение **не является строкой** — независимо от точки входа.

| Входное значение | typeof | actualTag |
|---|---|---|
| `null` | `'object'` | `'[object Null]'` |
| `undefined` | `'undefined'` | `'[object Undefined]'` |
| `123` | `'number'` | `'[object Number]'` |
| `true` | `'boolean'` | `'[object Boolean]'` |
| `[]` | `'object'` | `'[object Array]'` |
| `{}` | `'object'` | `'[object Object]'` |

**Важно:** `fromString()` тоже содержит runtime type guard. TypeScript предотвращает передачу не-строки в compile time, но вызов через `as any` обходит это. В таком случае возвращается `reason: INVALID_TYPE` — консистентно с `fromUnknown`. Семантика одинакова независимо от точки входа.

```typescript
// fromString — runtime type guard для консистентности
if (typeof value !== 'string') {
  const actualTag = Object.prototype.toString.call(value);
  throw new InvalidSideError(
    (ctx) => `Invalid side: must be string, got ${ctx.actualTag}`,
    {
      context: {
        kind: 'invalid_side_type',
        type: typeof value,
        actualTag,
        reason: SideErrorReason.INVALID_TYPE,
      },
    }
  );
}
```

**Зачем `actualTag`:** `typeof` возвращает `'object'` для `null`, массивов и объектов — не различить. `Object.prototype.toString.call(value)` даёт точный тег: `'[object Null]'`, `'[object Array]'`, `'[object Object]'`.

### INVALID_VALUE

Возникает когда значение **является строкой**, но не входит в `ALL_SIDES`.

| Входное значение | Причина |
|---|---|
| `'buy'` | Lowercase — case-sensitive |
| `'Sell'` | Title case — невалиден |
| `'INVALID'` | Отсутствует в ALL_SIDES |
| `''` | Пустая строка |
| `'BUY '` | Пробел в конце |

## Контракт "Never Throw"

Все методы `SideService` разделены на две группы:

**Методы парсинга** — возвращают `Result<Side, InvalidSideError>`, никогда не бросают:

- `SideService.fromString(value: string)`
- `SideService.fromUnknown(value: unknown)`

**Утилиты** — принимают уже валидный `Side`, возвращают значения напрямую:

- `SideService.opposite(side: Side): Side`
- `SideService.canMatch(side1: Side, side2: Side): boolean`
- `SideService.equals(a: Side, b: Side): boolean`
- `SideService.isValid(value: unknown): value is Side`
- `SideService.getAllValues(): readonly Side[]`

Утилиты безопасны по контракту — TypeScript гарантирует, что аргумент является валидным `Side` (уже прошёл парсинг). Дополнительного `wrapOp` не нужно.

## Реализация wrapOp без двойной вложенности

`fromUnknown` и `fromString` используют общий внутренний хелпер `parseSideOrThrow`, но каждый оборачивает его в **свой** `wrapOp`. Это исключает двойную обёртку контекста.

```text
fromUnknown()
  └─ wrapOp('fromUnknown', ...)
       ├─ type guard → INVALID_TYPE
       └─ parseSideOrThrow()  ← throws (без wrapOp)
            └─ INVALID_VALUE

fromString()
  └─ wrapOp('fromString', ...)
       ├─ type guard → INVALID_TYPE
       └─ parseSideOrThrow()  ← throws (без wrapOp)
            └─ INVALID_VALUE
```

Если бы `parseSideOrThrow` имел собственный `wrapOp`, то при вызове изнутри `fromUnknown` контекст содержал бы вложенный `opChain` с двумя уровнями — это усложняет трассировку ошибок.

## Диаграмма потока данных

```text
Входные данные (string | unknown)
         │
         ▼
 SideService.fromString()    SideService.fromUnknown()
         │                            │
         └──── wrapOp (op context) ───┘
                      │
          ┌───────────▼───────────┐
          │   runtime type guard  │
          │   typeof !== 'string' │
          └───────────┬───────────┘
                      │ string
                      ▼
          ┌───────────────────────┐
          │  parseSideOrThrow()   │
          │  isValidSide(value)   │
          │  SIDE_SET.has(value)  │
          └───────────┬───────────┘
                      │
           ┌──────────┴──────────┐
           │ true                │ false
           ▼                     ▼
      Ok(Side)         InvalidSideError
                       (INVALID_VALUE)
```

## Преимущества архитектуры

1. **Минимальный overhead** — Side это строка, нет объектов, нет аллокаций
2. **O(1) lookup** — `SIDE_SET` (Set) быстрее, чем `Array.includes()`
3. **Автоматическое расширение** — добавление значения в `ALL_SIDES` обновляет всё: `SIDE_SET`, `isValidSide()`, `getAllValues()`
4. **Консистентные ошибки** — `INVALID_TYPE` означает одно и то же из любой точки входа
5. **Never Throw** — Facade гарантирует отсутствие исключений

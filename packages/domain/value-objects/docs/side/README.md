# Side Value Object

Side представляет направление торговой операции: `'BUY'` или `'SELL'`.

## Обзор

Side — это string literal type alias (`'BUY' | 'SELL'`), не class.
Такой подход выбран потому что Side не имеет сложного внутреннего состояния и не требует private constructor для защиты инвариантов.

**Ключевые характеристики:**
- Два валидных значения: `'BUY'` и `'SELL'`
- Единственный источник правды — `ALL_SIDES` (frozen массив)
- Иммутабельный: `ALL_SIDES` заморожен через `Object.freeze`
- Case-sensitive: `'buy'` и `'BUY'` — разные строки, валидна только `'BUY'`

## Инварианты

1. **Два значения**: только `'BUY'` или `'SELL'`
2. **Case-sensitive**: строго uppercase
3. **Immutable set**: `ALL_SIDES` заморожен, runtime-мутация невозможна
4. **Single source of truth**: `isValidSide()` и `getAllValues()` производны от `ALL_SIDES`

## API

### Создание и валидация

```typescript
import { SideService } from '@polymarket/value-objects';

// Из строки — возвращает Result
const result = SideService.fromString('BUY');
if (result.ok) {
  const side = result.value; // 'BUY'
}

// Из unknown — для API/DB/user input
const parsed = SideService.fromUnknown(rawValue);
if (!parsed.ok) {
  console.error(parsed.error.message); // Invalid side: must be string, got [object Null]
}

// Type guard (возвращает boolean, не Result)
if (SideService.isValid(value)) {
  // value: Side
}
```

### Утилиты

```typescript
// Противоположная сторона
SideService.opposite('BUY');  // 'SELL'
SideService.opposite('SELL'); // 'BUY'

// Совместимость для order matching (противоположные стороны совпадают)
SideService.canMatch('BUY', 'SELL');  // true
SideService.canMatch('BUY', 'BUY');   // false

// Равенство
SideService.equals('BUY', 'BUY');  // true

// Все валидные значения (frozen)
SideService.getAllValues(); // readonly ['BUY', 'SELL']
```

### Сериализация

```typescript
import { SideSerializer } from '@polymarket/value-objects';

// Side уже является string — toJSON это identity function
const json = SideSerializer.toJSON('BUY'); // 'BUY'

// Десериализация
const result = SideSerializer.fromJSON('BUY');  // Result<Side, InvalidSideError>
const result2 = SideSerializer.fromUnknown(parsed.side); // Result<Side, InvalidSideError>
```

### Форматирование

```typescript
import { SideFormatter } from '@polymarket/value-objects';

SideFormatter.toDisplay('BUY');    // 'Buy'
SideFormatter.toUpperCase('BUY');  // 'BUY'
SideFormatter.toLowerCase('BUY');  // 'buy' (Lowercase<Side>)
SideFormatter.toLogString('BUY');  // '🟢 BUY'
SideFormatter.toColor('BUY');      // 'green'
SideFormatter.toHexColor('BUY');   // '#22c55e'
SideFormatter.toEmoji('BUY');      // '🟢'
SideFormatter.withSize('BUY', 100); // 'Buy 100'
```

> **Архитектурная заметка:** `toColor`, `toHexColor`, `toEmoji` — UI-представление.
> В будущем их следует вынести в отдельный presentation-пакет.

## Error handling

Все методы создания/парсинга возвращают `Result<Side, InvalidSideError>` и никогда не бросают исключений.

```typescript
import { SideErrorReason } from '@polymarket/value-objects';

const result = SideService.fromString('buy');
if (!result.ok) {
  switch (result.error.context?.reason) {
    case SideErrorReason.INVALID_VALUE:
      // Строка валидна, но не является Side (lowercase, неизвестное значение)
      break;
    case SideErrorReason.INVALID_TYPE:
      // Не строка (number, null, array, object)
      // context.actualTag содержит Object.prototype.toString: '[object Null]' и т.д.
      break;
  }
}
```

## Архитектура

```
side/
├── core/
│   └── Side.ts          # type Side, ALL_SIDES (frozen), SIDE_SET, isValidSide, утилиты
├── facade/
│   └── SideService.ts   # публичный API (fromString, fromUnknown, isValid, opposite...)
├── adapters/
│   ├── SideSerializer.ts # JSON сериализация
│   └── SideFormatter.ts  # UI форматирование
└── errors/
    └── SideErrorReason.ts # INVALID_VALUE | INVALID_TYPE
```

### Почему type alias, а не class?

Side не требует:
- Сложного внутреннего состояния (это просто строка)
- Decimal-точности или враппера
- Private constructor для защиты инвариантов (нет нарушаемых инвариантов внутри значения)

Инварианты (допустимые значения) защищаются на уровне фасада через `isValidSide()`.

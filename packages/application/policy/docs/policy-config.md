# Граница `config → canonical Policy`

## Проблема

Фабрики `createPolymarketPolicy()` / `createCexPolicy()` принимают **уже
canonical** объект. Значит вызывающий обязан ДО фабрики сам превратить:

```text
"btc"                   → CryptoAssetId
"5m"                    → MarketDuration
{amount:1000,…}         → Money
"0.02"                  → Ratio
"2026-09-01T18:00:00Z"  → Timestamp
```

При этом policy по замыслу собирается из конфигурационных файлов и
переменных окружения. Итог предсказуем: bot runtime, коллектор, загрузчик
экземпляров стратегии и backtest напишут по собственному ad-hoc парсеру, и
эти парсеры разойдутся — «5m» у одного окажется не тем же, что у другого.

## Решение

Одна чистая граница. Ни загрузчиков файлов, ни чтения окружения, ни
реестров — только функция «plain data → Policy»:

```ts
const policy = parsePolicyConfig({
  kind: 'POLYMARKET',
  family: 'CRYPTO_UP_DOWN',
  assets: ['btc'],
  durations: ['5m'],
  minLiquidity: { amount: 1000, currency: 'USDC' },
  effectiveFrom: '2026-09-01T18:00:00Z',
});

filter.filter(universe.getAll(), policy, evaluationTime);
```

Перегрузки сужают результат по виду конфига: разбор
`PolymarketPolicyConfig` возвращает `PolymarketPolicy`, а не union — иначе
каждый вызывающий с заведомо известным конфигом был бы обязан сузить
результат сам, и пример выше не скомпилировался бы без ручного `kind`-guard.

## Две двери, один путь валидации

```text
программный вызывающий ──→ createPolymarketPolicy()  ┐
                                                     ├─→ нормализация,
конфиг/JSON ──→ parsePolicyConfig() ─────────────────┘   кросс-проверки,
                                                         иммутабельность
```

Парсер **заканчивается** вызовом фабрики. Ни дедупликации, ни схлопывания
пустых списков, ни поиска противоречивых ключевых слов, ни проверки окна,
ни словаря `marketTypes`, ни `orderbook || trades`, ни глубины стакана в
парсере нет. Две системы валидации одного контракта разошлись бы так же
неизбежно, как разошлись бы ad-hoc парсеры.

Ответственности разделены строго:

| Кто | Что делает |
| --- | --- |
| `parse*Config()` | plain-примитивы → canonical-типы |
| `create*Policy()` | нормализация, кросс-полевая валидация, заморозка |

## Contracts

`PolicyConfig = PolymarketPolicyConfig | CexPolicyConfig`, дискриминация по
`kind`. В типах конфигов — **только** JSON-friendly значения: ни
`Timestamp`, ни `Money`, ни `Ratio`, ни `CryptoAssetId`, ни `MarketDuration`.

```ts
interface PolymarketPolicyConfig {
  kind: 'POLYMARKET';
  family: string;
  assets?: readonly string[];
  durations?: readonly string[];
  title?: { required?: string[]; anyOf?: string[]; excluded?: string[] };
  minLiquidity?: { amount: string | number; currency: string };
  minSpread?: string | number;
  effectiveFrom?: string;
  effectiveUntil?: string;
}
```

## Формат каждого поля

| Поле | Формат | Конструктор |
| --- | --- | --- |
| `family` | значение `MarketFamily`, регистр значим | `isValidMarketFamily` |
| `assets[i]` | тикер (`"btc"`) | `asCryptoAssetId` — **safe**, не `unsafe*` |
| `durations[i]` | `<число><m\|h>`: `5m`, `15m`, `30m`, `1h`, `4h` | regex → мс → `asMarketDuration` |
| `minLiquidity` | `{ amount, currency }` | `isSupportedCurrency` → `MoneyService.create` |
| `minSpread` | десятичная **дробь**: `"0.02"` = 2 % | `RatioService.fromDecimal` |
| `effectiveFrom/Until` | ISO-8601 | `TimestampService.fromISO` |

Везде используются существующие safe-конструкторы, возвращающие `Result`.
`unsafe*`-варианты на недоверенной границе не применяются — они и созданы
для случая, когда значение уже проверено, а здесь оно как раз не проверено.

Единицы длительности лежат в одном `ReadonlyMap`, из которого **выводятся**
и regex, и строка `expected` в сообщении об ошибке: два списка единиц
разошлись бы. Regex подтверждает только форму — границы (`0m` слишком мало,
`9000h` слишком много) отсекает `asMarketDuration`, второй копии этих правил
нет.

Формат намеренно один и документированный. `five-minutes`, `5`, `300000` не
принимаются: «угадать, что имелось в виду» — это решение за автора конфига.

## Ошибки: fail-fast с указанием поля

Любая проблема → `PolicyValidationError`. Никаких `undefined`, `null` или
частично собранной policy.

`context.field` называет **конкретное** поле, включая индекс элемента:

```text
assets[1] = ""                 → field: 'assets[1]'
durations[0] = "five"          → field: 'durations[0]', expected: '<number><m|h>'
family = "CRYPTO"              → field: 'family', allowed: MARKET_FAMILY_VALUES
minLiquidity.currency = "EUR"  → field: 'minLiquidity.currency', allowed: SUPPORTED_CURRENCIES
effectiveFrom = "tomorrow"     → field: 'effectiveFrom', expected: ISO-8601
marketTypes[0] = "futures"     → поле + список допустимых
```

Сообщение «policy невалидна» оставило бы читателю ровно ту задачу поиска,
ради устранения которой граница и создана.

### Неизвестный `kind`

Конфиг приходит из `JSON.parse`, то есть **вне** системы типов. Поэтому
неизвестный `kind` тоже даёт `PolicyValidationError`, а не проваливается в
`switch` без ветки. Обработчик принимает параметр типа `never`: пропуск
новой ветви при добавлении третьего вида policy станет ошибкой компиляции.

## Что сюда НЕ входит

`StrategyInstanceConfig`, `StrategyRegistry`, owner/claims/ref-count,
`PolicyRegistry`, subscription planner и controller, загрузчики YAML/JSON/env,
чтение файлов. Граница — чистая функция; откуда взялись plain-данные, её не
касается.

## Зачем это нужно прямо сейчас

Сценарий, который граница делает возможным (закреплён тестом
`strategy-instances.test.ts`): **одна** реализация стратегии запускается
**двумя** экземплярами с разными конфигами рынка.

```text
config A → policy A → BTC / 5m   ┐
                                 ├─→ один MarketUniverse
config B → policy B → ETH / 15m  ┘
```

Policy собираются независимо, не разделяют состояние и иммутабельны;
повторный разбор одного конфига даёт равные, но **не те же** объекты —
общий объект policy означал бы, что правка конфигурации одного экземпляра
меняет поведение другого.

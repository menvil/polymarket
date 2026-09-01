# Canonical Market Entity

## Обзор

`Market` — единственное каноническое доменное представление **наблюдаемого внешнего
prediction market**. Это граница между инфраструктурой и приложением:

```text
Polymarket V2 client/bindings   (@polymarket/client, @polymarket/bindings)
  ↓
Infrastructure mapping           (vendor → canonical)
  ↓
Domain Market                    ← этот пакет
  ↓
Application
```

Ниже границы живут vendor-типы (V2 client/bindings, Gamma DTO, RTDS-сообщения). Выше —
только canonical value objects. Domain Market не зависит ни от V2, ни от legacy V1.

> **V1/V2.** `@polymarket/client` и `@polymarket/bindings` — это V2 client/bindings нового
> контура, а не «official SDK». Domain Market не зависит ни от одного из них.

## Структура пакета

```text
packages/domain/entities/market/
└── src/
    ├── Market.ts                    # Entity: identity, структура, расписание, состояние
    ├── MarketTradingPolicy.ts       # Производная фаза рынка (не хранится)
    ├── value-objects/
    │   ├── MarketState.ts           # ACTIVE | CLOSED | RESOLVED + переходы-наблюдения
    │   ├── MarketStatus.ts          # 'ACTIVE' | 'CLOSED' | 'RESOLVED'
    │   ├── MarketOutcome.ts         # index + label + InstrumentId
    │   ├── MarketFamily.ts          # 'CRYPTO_UP_DOWN' | 'BINARY_OUTCOME'
    │   ├── MarketSpec.ts            # CryptoUpDownSpec (asset + duration)
    │   ├── MarketDuration.ts        # Номинальная длительность серии (branded ms)
    │   ├── MarketSlug.ts            # URL-safe branded type (a-z0-9-)
    │   └── index.ts
    ├── view/
    │   ├── MarketSnapshot.ts        # Доменно-типизированный data carrier
    │   ├── MarketJSON.ts            # Сериализованная форма (примитивы)
    │   ├── MarketParser.ts          # unknown JSON → MarketSnapshot
    │   └── MarketViewModel.ts       # Market → snapshot / JSON
    └── index.ts
```

> **Идентификаторы из `@polymarket/ids`:** `MarketId`, `VenueId`, `InstrumentId`,
> `CryptoAssetId`. Ошибки — из `@polymarket/errors/market` (реэкспортированы пакетом).

---

## Контракт Market

```typescript
class Market {
  readonly id: MarketId;
  readonly venueId: VenueId;
  readonly slug?: MarketSlug;
  readonly question: string;

  readonly startsAt: Timestamp;
  readonly expiresAt: Timestamp;

  readonly state: MarketState;                              // ACTIVE | CLOSED | RESOLVED
  readonly outcomes: readonly [MarketOutcome, MarketOutcome];
  readonly family: MarketFamily;                            // CRYPTO_UP_DOWN | BINARY_OUTCOME
  readonly crypto?: CryptoUpDownSpec;                       // только для CRYPTO_UP_DOWN

  get resolvedOutcome(): MarketOutcome | undefined;

  // Расписание — детерминированно, без wall clock
  isStartedAt(now: Timestamp): boolean;
  isExpiredAt(now: Timestamp): boolean;
  timeToStartAt(now: Timestamp): Decimal;
  timeToExpiryAt(now: Timestamp): Decimal;
  duration(): Decimal;

  // Предикаты состояния
  isActive(): boolean;
  isClosed(): boolean;
  isResolved(): boolean;

  // Фиксация внешних наблюдений
  markClosed(): Result<Market, MarketAlreadyResolvedError>;
  markResolved(index: OutcomeIndex): Result<Market, MarketValidationError | MarketAlreadyResolvedError>;

  equals(other: Market): boolean;   // venueId + id
  toString(): string;
}
```

---

## Почему так сделано?

### 1. Market — наблюдение, а не команда

`Market` представляет то, что мы **видим у площадки**. Мы не открываем и не закрываем
внешний рынок. Отсюда:

- методы переходов называются `markClosed()` / `markResolved()`, а не `close()` / `resolve()`;
- `MarketState` — «подтверждённое внешнее состояние», а не «состояние, которым мы управляем»;
- никакого `forceClose`: административного сценария «закрыть чужой рынок» не существует.

### 2. Что в Market НЕ входит

```text
liquidity   spread   orderbook   last trade   current price   reference price
RTDS-подписки   Gamma Market/Event   SDK-объекты   Record<string, unknown> payloads
```

**Причина:** это быстро меняющиеся наблюдаемые метрики и состояние рынка, а не его
identity/структура. Хранить их в entity значит либо пересоздавать `Market` на каждый тик
стакана, либо держать в нём устаревшие значения. Стакан живёт в `@polymarket/orderbook`,
лента — в `@polymarket/trade-tape`, топ книги — в `StrategySnapshot.topOfBook`,
`spread`/`liquidity` кандидатов — в `DiscoveredMarket` (application-порт discovery).

Отдельный runtime `MarketMetrics` в этом MR **не заводится**: ни одному существующему
контракту он не нужен, а тип без потребителя — это dead code.

### 3. Один outcome → одна canonical instrument identity

```typescript
interface MarketOutcome {
  readonly index: OutcomeIndex;      // 0 | 1
  readonly label: string;            // 'Up' / 'Down'
  readonly instrumentId: InstrumentId;
}
```

Раньше исход нёс `OutcomeToken` — on-chain identity (`conditionRef` + `outcomeKey` →
`AssetId`). Это делало Domain Market пригодным только для on-chain площадок: `OutcomeToken`
по своему контракту существует лишь для tokenized positions, а у Kalshi и любой off-chain
площадки таких токенов нет.

Весь новый market-data контур (`Orderbook`, `TradeTape`, semantic-адаптеры,
`StrategySnapshot`, `Portfolio.getPosition`) адресует исход по `InstrumentId`. Держать
рядом обязательные `token` и `instrumentId` означало бы две параллельные canonical identity
одной сущности. Поэтому canonical owner identity исхода — `InstrumentId`.

`OutcomeToken` остаётся тем, чем он и является: on-chain-специфичным VO расчётного контура
(`@polymarket/value-objects/outcome-token`, потребитель — `TokenBalance`). Из `Market` он
удалён, из репозитория — нет.

### 4. Расписание через `Timestamp`, без wall clock

`startsAt` и `expiresAt` — `Timestamp`, а не bare `number`. Все временные методы принимают
момент наблюдения параметром: внутри `Market` нет ни одного `Date.now()`. «Сейчас»
вызывающий берёт из инжектированного `IClock`, поэтому live и backtest используют
**одну и ту же** entity.

Разницы возвращаются как `Decimal` через `Timestamp.diffMs` — по
`docs/architecture/boundary-contract.md`, Решение 3 («длительность = разница двух Timestamp
→ `Timestamp.diffMs`, не ручное `a.toNumber() - b.toNumber()`»).

Инвариант: `startsAt < expiresAt` строго.

### 5. Истечение срока не меняет состояние

Один и тот же `ACTIVE`-рынок может быть:

```text
до startsAt                              — опубликован, торги не начались
между startsAt и expiresAt               — идёт
после expiresAt, площадка молчит         — расписание истекло, vendor всё ещё ACTIVE
```

Поэтому `ACTIVE → CLOSED` происходит **только** после подтверждения площадкой. Автоматической
мутации по таймеру нет — иначе наше состояние расходилось бы с источником.

### 6. Фаза вычисляется, а не хранится

```typescript
type MarketPhase = 'PRE_OPEN' | 'OPEN' | 'ENDED' | 'CLOSED' | 'RESOLVED';

MarketTradingPolicy.getPhase(market, now);
```

| Фаза | `market.state` | Расписание | Что делает runtime |
|---|---|---|---|
| `PRE_OPEN` | ACTIVE | `now < startsAt` | можно подписываться на маркет-данные |
| `OPEN` | ACTIVE | `startsAt ≤ now < expiresAt` | рынок идёт, стратегия торгует |
| `ENDED` | ACTIVE | `now ≥ expiresAt` | стратегия не торгует; vendor ещё ACTIVE |
| `CLOSED` | CLOSED | не влияет | подтверждено: отменить ордера, ждать исход |
| `RESOLVED` | RESOLVED | не влияет | исход объявлен: settlement |

`PRE_OPEN`/`OPEN`/`ENDED` не попадают в хранимый `MarketState`: они меняются от одного лишь
хода часов, без внешнего наблюдения. Храни мы их в entity — пришлось бы пересоздавать
`Market` по таймеру, и любая копия мгновенно устаревала бы.

### 7. FSM отражает наблюдение, а не внутреннюю дисциплину

```text
ACTIVE → CLOSED        ACTIVE → RESOLVED        CLOSED → RESOLVED
CLOSED → CLOSED        RESOLVED(i) → RESOLVED(i)   — идемпотентно
```

**`ACTIVE → RESOLVED` разрешён.** Между двумя опросами источника рынок мог успеть и
закрыться, и разрезолвиться. Наша система не имеет права ответить «не может быть RESOLVED,
я лично CLOSED не видела»: площадка не обязана показывать каждое промежуточное состояние,
а RESOLVED по смыслу уже влечёт окончание торгов. Требование «сначала покажи закрытие»
отвергало бы корректное внешнее наблюдение из-за нашей собственной частоты опроса.

**Повторное наблюдение того же состояния — не ошибка.** Внешние снапшоты повторяются;
превращать каждый цикл опроса в `Err` значит заставлять вызывающего отличать «ничего не
изменилось» от настоящей проблемы на каждом тике. Идемпотентный переход возвращает **тот
же экземпляр**, поэтому no-op отличим по ссылке: `result.value === market`.

**Отклоняются только противоречия уже зафиксированному факту:**

```text
RESOLVED    → CLOSED         регрессия: терминальное состояние необратимо
RESOLVED(i) → RESOLVED(j≠i)  конфликт: источник объявил другой исход
```

Правила живут в `MarketState`, entity их не знает:

```typescript
// В Market.markClosed():
const next = MarketState.markClosed(this.state, { marketId: this.id, venueId: this.venueId });
// ↑ MarketState знает правила; Market только пробрасывает Result наверх
```

Переходы возвращают `Result`, а не бросают — по
`docs/architecture/boundary-contract.md`, Решение 2 (throw легитимен только внутри
`packages/domain/value-objects`).

```text
MarketLifecycleError
└── MarketAlreadyResolvedError   регрессия из RESOLVED или конфликт исхода
```

`MarketAlreadyClosedError` и `MarketInvalidTransitionError` **удалены** из
`@polymarket/errors/market`: после перехода к наблюдательной семантике у них не осталось
ни одного продюсера — «уже закрыт» стало идемпотентным `Ok`, а `markResolved()` из ACTIVE
стало легальным. Оставлять их значило бы документировать как часть контракта Market
ошибки, которые он никогда не вернёт.

### 8. Семейство рынка и его спецификация

```typescript
type MarketFamily = 'CRYPTO_UP_DOWN' | 'BINARY_OUTCOME';

interface CryptoUpDownSpec {
  readonly asset: CryptoAssetId;     // 'btc'
  readonly duration: MarketDuration; // 300_000 — номинал 5-минутной серии
}
```

| Семейство | Что означает | Спецификация |
|---|---|---|
| `CRYPTO_UP_DOWN` | цена актива вырастет/упадёт за окно | `crypto` **обязательна** |
| `BINARY_OUTCOME` | два взаимоисключающих исхода и расписание | `crypto` **запрещена** |

`MarketFamily` — закрытый union, а не branded string: каждое семейство требует своей
ветки в маппинге Infrastructure, и неизвестное семейство интерпретировать невозможно.

`BINARY_OUTCOME` — не «неизвестное семейство» и не escape hatch: это точное утверждение
о том, что мы знаем про рынок, — два исхода и окно торгов, и ничего сверх того. Оно
появилось не умозрительно, а потому что бот реплеит снапшоты без `rawMarket`
(`DataRecorder` пишет его условно) и рынки, чей `resolutionSource` не указывает на
Binance/Chainlink: такой рынок торгуется и обязан быть представим, но crypto-спецификации
у него нет и выдумать её нельзя.

Связка «семейство → спецификация» проверяется в `Market.create()` **в обе стороны** —
иначе `BINARY_OUTCOME` стал бы дырой, через которую crypto-данные попадают в рынок,
который их не имеет. `MarketParser` симметричен: crypto-спека на не-crypto семействе —
это `Err`, а не молча отброшенное поле.

`crypto.duration` (номинал серии) и `market.duration()` (фактический интервал расписания) —
разные величины. Обычно совпадают, но площадка может сдвинуть окно конкретного рынка на
секунды, оставив его в той же 5-минутной серии. `Market.create()` их на равенство **не**
проверяет — иначе реальный рынок со сдвинутым окном стало бы невозможно описать.

Практическое следствие для маппинга: номинал берётся из окна крипто-**события**
(`eventStartTime`..`endDate`), а `startsAt`/`expiresAt` — из расписания самого **рынка**.
Выводить номинал из `expiresAt - startsAt` значит схлопывать ровно то различие, ради
которого `MarketDuration` и существует.

### 9. «Нет значения» означает «нет ключа»

Необязательные поля (`slug`, `crypto`) объявлены с модификатором `declare`. Без него
TypeScript при `target: ES2022` эмитирует объявление поля, и класс определяет ключ даже
когда значения нет — `'crypto' in market` возвращал бы `true` со значением `undefined`,
хотя снапшот и JSON этот ключ не содержат. Асимметрия ломает любого потребителя, который
проверяет наличие через `in` вместо `!== undefined` (такие дефекты в сериализаторах
репозитория уже находили). С `declare` поле появляется только при присваивании в
конструкторе, и отсутствие выглядит одинаково на всех трёх представлениях.

Практическое следствие: у рынка семейства `BINARY_OUTCOME` ключа `crypto` нет вовсе —
не «есть со значением `undefined`».

### 10. Иммутабельность гарантирует entity, а не вызывающий

`Market` не сохраняет `props.state` по ссылке: конструктор пересоздаёт состояние через
`MarketState.normalize()` (канонические конструкторы уже возвращают `Object.freeze`).
Исходы и crypto-спецификация замораживаются там же. Без этого изменяемый литерал,
переданный в `Market.create()`, оставался бы общим с entity, и мутация у вызывающего
незаметно меняла бы «иммутабельный» рынок.

`MarketViewModel.toSnapshot()` по той же причине **копирует** состояние и исходы, а не
отдаёт ссылки: снапшот — отдельный объект, и его мутация не должна доставать до Market.

### 11. Notifications удалены

Старый пакет держал notification outbox: `close()`/`resolve()` складывали
`MarketClosedNotification`/`MarketResolvedNotification` в буфер, а `pullNotifications()`
его забирал. В новой модели механизм удалён по трём причинам сразу:

1. **Нет потребителей.** Repo-wide поиск `pullNotifications` за пределами самого пакета не
   находит ничего: никто не забирал буфер и никто эти уведомления не публиковал.
2. **Дублирование существующего application-контура.** `MARKET_CLOSED` уже существует как
   `MarketClosedEvent` в `@polymarket/application-events` — canonical envelope M-003
   (`{ type, payload, metadata }`) с causal chain, runtime identity и ordering. Доменный
   plain-объект этих гарантий дать не может, а два параллельных «события закрытия рынка» —
   это ровно тот третий шинный контур, которого архитектура избегает.
3. **Мутация иммутабельной entity.** Буфер требовал изменяемого массива внутри полностью
   readonly-объекта, а `pullNotifications()` был мутирующим методом на «неизменяемой»
   сущности. После перехода к наблюдательной семантике это стало и содержательно неверным:
   `occurredAt` уведомления — время **нашего наблюдения**, а не время закрытия рынка на
   площадке; публиковать его как доменный факт было бы неточно.

Публикация событий жизненного цикла рынка — ответственность application-слоя, который
знает и причину (`MarketCloseReason`), и реализованный PnL, и корректную metadata.

### 12. Presentation: почему больше нет `getMarketUrl()`

Метод собирал `https://polymarket.com/event/{slug}` — зашивал в generic domain entity знание
о конкретной площадке и о том, что слаг вообще есть. После перевода `Market` на `venueId` +
необязательный `slug` это стало прямым противоречием модели: у Kalshi-рынка такого URL не
существует. Построение ссылок — задача presentation-слоя конкретной площадки. Потребителей
у метода не было, поэтому он удалён, а не перенесён.

---

## Сериализация

Два разных представления, оба нужны:

```text
MarketSnapshot — доменные типы (Timestamp, InstrumentId, MarketState), in-memory
MarketJSON     — примитивы (number, string), БД / кэш / сеть
```

```text
Market ──MarketViewModel.toSnapshot()──▶ MarketSnapshot ──Market.fromSnapshot()──▶ Market
Market ──MarketViewModel.toJSON()─────▶ MarketJSON ──MarketParser.from()──▶ MarketSnapshot
```

`MarketParser` принимает `unknown` и не знает ни `@polymarket/client`, ни
`@polymarket/bindings`, ни Gamma DTO, ни RTDS. Он разбирает **нашу собственную**
сериализацию canonical Market. Vendor → Domain маппинг живёт в Infrastructure.

**Граница ответственности:** парсер отвечает за «данные пригодны к типизации» (строка ли
`id`, число ли `startsAt`, известен ли `status`). Доменные инварианты (различимость исходов,
`startsAt < expiresAt`, обязательность crypto-спецификации) проверяет `Market.create()` — в
одном месте и одинаково для парсинга и первичного создания.

---

## Примеры

### Создание canonical рынка

```typescript
import { Market, MarketState, MarketTradingPolicy, asMarketDuration } from '@polymarket/market';
import { KnownVenues, unsafeMarketId, unsafeInstrumentId, unsafeCryptoAssetId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/timestamp';

const startsAt = TimestampService.fromISO('2026-09-01T12:00:00.000Z');
const expiresAt = TimestampService.fromISO('2026-09-01T12:05:00.000Z');
if (!startsAt.ok || !expiresAt.ok) throw new Error('bad schedule');

const created = Market.create({
  id: unsafeMarketId('btc-up-down-1200'),
  venueId: KnownVenues.POLYMARKET,
  question: 'Bitcoin Up or Down — 12:00 to 12:05?',
  startsAt: startsAt.value,
  expiresAt: expiresAt.value,
  state: MarketState.active(),
  outcomes: [
    { index: 0, label: 'Up', instrumentId: unsafeInstrumentId('71476031705491') },
    { index: 1, label: 'Down', instrumentId: unsafeInstrumentId('22993088410122') },
  ],
  family: 'CRYPTO_UP_DOWN',
  crypto: { asset: unsafeCryptoAssetId('btc'), duration: asMarketDuration(5 * 60_000)! },
});
```

### Фаза без мутации Market

```typescript
const market = created.value;

MarketTradingPolicy.getPhase(market, at('11:59')); // → 'PRE_OPEN'
MarketTradingPolicy.getPhase(market, at('12:02')); // → 'OPEN'
MarketTradingPolicy.getPhase(market, at('12:05')); // → 'ENDED'

market.state.status; // всё ещё 'ACTIVE' — фаза нигде не сохранена
```

### Фиксация внешних наблюдений

```typescript
const closed = market.markClosed();          // площадка подтвердила закрытие
if (!closed.ok) {
  logger.warn('Close observation rejected', { code: closed.error.name });
  return;
}
if (closed.value === market) {
  // Тот же экземпляр — рынок уже был закрыт, повторный снапшот источника
}

const resolved = closed.value.markResolved(0); // объявлен победивший исход
if (resolved.ok) {
  settlement.payout(resolved.value.resolvedOutcome!.instrumentId);
}
```

### Round-trip через сериализацию

```typescript
const wire = JSON.parse(JSON.stringify(MarketViewModel.toJSON(market)));

const snapshot = MarketParser.from(wire);
if (!snapshot.ok) return;

const restored = Market.fromSnapshot(snapshot.value);
```

---

## Тесты

```text
__tests__/unit/
├── fixtures.ts                        # Модельный рынок BTC Up/Down 12:00–12:05
├── Market.test.ts                     # Construction, Time, Transitions, Snapshot
├── MarketTradingPolicy.test.ts        # Фазы, включая границы 12:00 и 12:05
├── MarketParser.test.ts               # Разбор сериализованных данных + граница с create()
├── MarketViewModel.test.ts            # toSnapshot / toJSON / полный round-trip
└── value-objects/
    ├── MarketId.test.ts
    ├── MarketSlug.test.ts
    ├── MarketState.test.ts            # Переходы-наблюдения, иммутабельность
    ├── MarketFamily.test.ts
    └── MarketDuration.test.ts
```

Ключевые границы, зафиксированные тестами (рынок 12:00–12:05):

```text
11:59:59 → не начался      12:00:00 → начался
12:04:59 → не истёк        12:05:00 → истёк

ACTIVE + 11:59 → PRE_OPEN   ACTIVE + 12:00 → OPEN   ACTIVE + 12:05 → ENDED
CLOSED   → CLOSED   независимо от часов
RESOLVED → RESOLVED независимо от часов

ACTIVE → CLOSED / ACTIVE → RESOLVED / CLOSED → RESOLVED   принимаются
CLOSED → CLOSED / RESOLVED(i) → RESOLVED(i)               идемпотентны, тот же экземпляр
RESOLVED → CLOSED / RESOLVED(i) → RESOLVED(j≠i)           отвергаются
```

---

## Вне scope этого пакета

`PolymarketMarketDiscovery`, `MarketFilter`, `MarketScorer`, `CollectionCoordinator`,
subscription control, CEX, semantic-адаптеры и backtest runtime продолжают работать на
своих текущих контрактах. Перевод V2 Discovery на canonical `Market` — следующий MR.

---

## Открытый вопрос для Discovery MR: обязательный `startsAt`

Решить **до** начала Discovery MR — он упрётся в это сразу.

`Market.create()` требует точный `startsAt`. Но V2 Discovery устроен так, что
normalized list-market точного начала события не содержит: `eventStartTime` приходит
только из `fetchEvent()` и только для уже выбранного рынка — специально, чтобы не делать
N+1 запрос по всем кандидатам. Планируемый конвейер из-за этого замыкается в круг:

```text
V2 listMarkets → дешёвая crypto-вселенная → Domain Market[] → Policy/Filter/Scorer
                                                ↑                      ↓
                                     нужен точный startsAt  ←  выбранные рынки → enrichment
```

Три варианта, ни один пока не выбран:

| Вариант | Суть | Цена |
|---|---|---|
| **A** | `startsAt` необязателен до enrichment | `getPhase()` должен уметь отвечать чем-то вроде `UNKNOWN_SCHEDULE` — размывает фазовую модель |
| **B** | Выводить `startsAt` из lightweight V2 данных (slug/question/структурное поле) | Лучший вариант, **если** подтверждается на fixtures и live-данных |
| **C** | Enrichment всех Crypto Up/Down после дешёвой классификации, `Market[]` строится уже после | Ослабляет запрет N+1, но только для маленькой supported-вселенной; приемлемо, если после отсева не-крипто остаются десятки, а не сотни рынков |

Первый шаг Discovery MR — измерить: что реально есть в lightweight V2 ответе и сколько
crypto-кандидатов остаётся после классификации. Выбор варианта — по этим данным, а не
заранее.

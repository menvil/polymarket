# @polymarket/exchange (`packages/infrastructure/polymarket`)

## Обзор

Инфраструктурный слой интеграции с Polymarket CLOB/Gamma API — самый крупный и
"пограничный" пакет всей кодовой базы: он реализует REST/WS-клиенты, доменные адаптеры
(`IExchangeClient`/`IMarketDiscoveryService` из `@polymarket/ports`), аутентификацию
(EIP-712/HMAC), DNS-обход блокировок и классификацию ошибок биржи. Наибольший
миграционный raw-долг во всей таблице (`docs/migration/debt.md`: 421 rawString/171
rawNumber/70 throw) — это ОЖИДАЕМО: весь пакет — граница между сырым venue-payload'ом
(JSON/WS-фреймы) и типизированным доменом (Решение 1 ADR), а не забытый этап миграции.

**4 публичных subpath-экспорта** (`package.json`'s `exports`, никакого top-level
`index.ts`/`main` нет): `@polymarket/exchange/rest`, `/ws`, `/adapters`, `/dns`.
`catalog/`, `errors/`, `events/`, `ports/`, `sdk/`, `stubs/` — не экспортируются наружу,
доступны только внутри пакета через относительные импорты.

```typescript
import { PolymarketRestAdapterFactory } from '@polymarket/exchange/rest';
import { PolymarketWsAdapter } from '@polymarket/exchange/ws';
import { MarketDataFeedAdapter, PolymarketMarketDiscoveryAdapter } from '@polymarket/exchange/adapters';
import { DnsOverride } from '@polymarket/exchange/dns';
```

## Карта директорий

| Директория | Назначение |
|---|---|
| `adapters/` | Мост infrastructure → application: `PolymarketExchangeClientAdapter`, `MarketDataFeedAdapter`, `PolymarketMarketDiscoveryAdapter` |
| `rest/adapters/` | `PolymarketExecutionAdapter` — чистые REST-вызовы размещения/отмены ордеров, без валидации |
| `rest/clients/` | Сырые HTTP-клиенты по группам эндпоинтов: `PolymarketOrderRestClient`, `PolymarketMarketDataRestClient` (Gamma API) |
| `rest/mappers/` | Двунаправленная конвертация wire↔domain: `PolymarketOrderMapper`, `PolymarketBalanceMapper` |
| `rest/policies/` | Pre-flight проверки: `PolymarketBalancePolicy` (достаточность USDC/токенов), `PolymarketMarketConstraintsPolicy` (нормализация размера, учится на ответах API) |
| `rest/providers/` | Реализации портов чтения: `PolymarketBalanceProvider implements IBalanceProvider`, `PolymarketPositionsProvider implements IPositionsProvider` |
| `rest/auth/` | `PolymarketSigner` (ECDSA/ethers), `PolymarketL2Authenticator` (HMAC-SHA256), `PolymarketOrderBuilder` (EIP-712 CLOB V2) |
| `ws/` | WS-транспорт и парсинг (см. раздел ниже) |
| `catalog/` | `PolymarketMarketCatalog` — in-memory реестр `InstrumentId → InstrumentInfo` |
| `dns/` | `DnsOverride` — обход блокировки/спуфинга DNS провайдером |
| `errors/` | `ErrorClassifier` — классификация сырых ошибок API в `OrderError`-union, LRU-кэш |
| `events/` | `EventEnvelope`/`ExecutionContext`/`ExecutionEvent` — временные внутренние формы событий |
| `ports/` | 9 узких локальных интерфейсов, специфичных для этого пакета (не путать с `@polymarket/ports`) |
| `sdk/` | Документированные заглушки под официальный `@polymarket/clob-client` (WS + REST) |
| `stubs/` | Заготовки под будущее выделение в отдельные пакеты — разной степени "живости" |

## WS-слой: cast транспорта

```
PolymarketWebSocketManager (сырой транспорт, extends BaseWebSocketTransport)
  → PolymarketWsClient (только транспорт, не экспортируется из ws/index.ts)
    → PolymarketMessageRouter (парсинг+роутинг, не экспортируется)
      → PolymarketWsAdapter (implements IPolymarketWsEmitter — единственная публичная точка)
```

`RtdsWebSocketClient` — отдельный, не связанный с этой цепочкой протокол-клиент для
крипто-ценовых фидов (не наследует `BaseWebSocketTransport`).

`sdk/PolymarketOfficialWsAdapter.ts` — документированная заглушка (`🚧 ЗАГЛУШКА 🚧`),
каждый метод бросает `'...not implemented - use WS_CLIENT_TYPE=custom'`; реальный путь —
`ws/PolymarketWsAdapter.ts` (уже подтверждено в Этапе 0 плана миграции, актуально и
сегодня). `sdk/PolymarketOfficialRestAdapter.ts` — параллельная заглушка для REST.

## Известные, осознанно не устраняемые пробелы

Пакет несёт несколько САМОдокументированных архитектурных ограничений — зафиксированы здесь
явно, чтобы не выглядели забытыми:

- **`ports/IEventBus.ts`'s `EventEnvelope`/`ApplicationEvent`-несовпадение формы.**
  `PolymarketExecutionAdapter`'s 6 сайтов публикации оборачивают событие в локальный
  `EventEnvelope<T> = { event: T; context: ExecutionContext; timestamp: Date }` без
  top-level `.type`-поля, а реальный `EventBus.publish()` матчит подписчиков по
  `event.type` — то есть эти события, вероятнее всего, **никогда не долетают ни до одного
  подписчика в проде**. Найдено и задокументировано в Этапе 10d плана миграции при снятии
  `publishOrThrow`-моста; исправление потребовало бы редизайна того, как этот адаптер
  доставляет события до шины — вне мандата этой миграции (типизация/`Result`, не
  архитектура доставки событий).
- **`rest/PolymarketMarketCatalog.ts`** — второй, по-другому спроектированный класс с тем
  же именем, что `catalog/PolymarketMarketCatalog.ts`, но не экспортируется из
  `rest/index.ts` и не имеет ни одного импортёра нигде в репозитории — похоже на
  орфанный/мёртвый код, не входит в мандат этого этапа удалять.
  `stubs/ethers/` аналогично — заглушка `Wallet`, ноль импортёров (реальный код
  аутентификации, `rest/auth/PolymarketSigner.ts`/`PolymarketOrderBuilder.ts`, использует
  настоящий npm-пакет `ethers` напрямую).
- **`ports/IMarketDataFeed.ts`** — собственный докблок уже помечает интерфейс как
  устаревающий ("Phase 0.5... этот интерфейс устареет").
- **`stubs/`'s неоднородная "живость"**: `stubs/domain/` (тип `ConstraintViolation`,
  реально используется `errors/ErrorClassifier.ts`) и `stubs/shared/websocket/`
  (`BaseWebSocketTransport`/`IMessageFormatter`, реально расширяются WS-слоем) — несмотря
  на название "STUB", это боевой код, стоящий на месте ещё не выделенного общего пакета;
  `stubs/ethers/` — единственный из трёх реально мёртвый.

## DNS-обход (`dns/DnsOverride`)

Подменяет `dns.lookup` (используемый `fetch`/`WebSocket` через undici) заранее
разрешёнными IP вместо системного резолвера — решает конкретную операционную проблему:
DNS-провайдер клиента блокирует или подменяет ответы для хостов Polymarket. Реальные IP
резолвятся через DNS-over-HTTPS к Cloudflare, пул адресов ротируется через `IpStore`.

## Ссылки

- Порты, которые реализует этот пакет: `@polymarket/ports` (`docs/ports.md`) —
  `IExchangeClient`, `IMarketDiscoveryService`, `IBalanceProvider`, `IPositionsProvider`
- `docs/architecture/bridge-adapters.md` — более широкий контекст роли infrastructure-
  адаптеров в системе
- ADR: `docs/architecture/boundary-contract.md` (Решение 1 — граница примитив/VO, почему
  этот пакет несёт наибольший raw-долг легитимно)
- План миграции, Этапы 0/10a/10c/10d/11:
  `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`

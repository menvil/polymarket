# @polymarket/cex-market-data

## Обзор

Сбор рыночных данных с CEX-бирж (Binance, Coinbase, OKX и др.) через `ccxt.pro`
WebSocket-потоки: стаканы и сделки, с опциональной записью на диск (JSONL + gzip-ротация) и
опциональной трансляцией downstream-потребителям (`CryptoMarketDataStore` в
`apps/bot`/`application/market-state`).

| Экспорт | Назначение |
|---|---|
| `CexCollectorService` | Верхнеуровневый сервис: объединяет watcher'ы + ротатор + sinks, `start()`/`stop()` |
| `CcxtSymbolWatcher` | Один WS-watcher на пару (биржа × символ): стакан + сделки |
| `CcxtExchangeWatcher` | Watcher на уровне биржи целиком (мультиплексирует символы одного соединения) |
| `CexFileRotator` | Запись сырых записей в JSONL с ротацией по временным окнам + gzip |
| `RestartingTask` | Универсальный self-healing task runner: backoff, jitter, cooldown после серии сбоев |
| `normalizeCexRawRecord` | `CexRawRecord` (сырое, `t: 'ob'\|'trade'`) → `CexNormalizedEvent` (с метаданными биржи/символа) |
| `CexCollectorConfig`/`CexExchangeConfig` | Конфигурация коллектора: биржи, символы, глубина стакана, интервалы перезапуска |

```typescript
import { CexCollectorService } from '@polymarket/cex-market-data';

const service = new CexCollectorService(config, logger);
service.start();
// ... event-driven сбор данных, опционально запись на диск через CexFileRotator ...
await service.stop(); // останавливает все watcher'ы, закрывает ротатор, чистит недописанные файлы
```

## Архитектура: почему три уровня watcher'ов

`CexCollectorService` не общается с `ccxt.pro` напрямую — она конструирует
`CcxtExchangeWatcher`/`CcxtSymbolWatcher` (per-биржа/per-символ WS-подписки) поверх общего
`RestartingTask` (self-healing запуск с exponential backoff + jitter + cooldown после серии
неудач — предотвращает WS-реconnect storm при затяжном сбое биржи). Плановый принудительный
перезапуск ccxt.pro-инстансов (по умолчанию каждые 30 минут для `CexCollectorService`, 2 часа
для watcher-уровня по умолчанию) — не восстановление после сбоя, а профилактика: без него
внутренний стейт (WS-буферы, кэши) накапливался и приводил к росту RSS до 4 ГБ на практике.

## Почему `bids`/`asks`/`price`/`size` остаются `number`

`CexNormalizedBookEvent.bids/asks: readonly (readonly [number, number])[]`,
`CexNormalizedTradeEvent.price/size: number` — сырые примитивы, не VO. В отличие от
аналогичного решения для `CryptoMarketDataStore` (Этап 8 плана миграции, обоснованное
одновременно частотой per-tick вызовов И диапазон-конфликтом с `OutcomePrice` VO), это **не** та же
осознанная hot-path-находка — этот пакет просто не был затронут ни одним этапом миграции
1-10 (найдено при расследовании Этапа 10 как "новая территория вне периметра черновика").
Единственный реальный потребитель (`apps/bot/src/main.ts`'s `routeCexEventToCryptoStore`)
тут же передаёт эти поля в `CryptoMarketDataStore.updateCexBook/updateCexTrade`, который сам
принимает `number` по собственному, отдельно обоснованному решению — то есть даже
конвертация этого пакета не изменила бы тип на стороне единственного получателя.
Зафиксировано как известный, осознанно неразрешённый пробел (не входит в мандат Этапа 11 —
этот этап про документацию и ESLint-гейт, не про новые VO-конверсии) — кандидат для
отдельного будущего рассмотрения, если появится второй потребитель с иными требованиями.

## Ссылки

- Потребитель: `apps/bot/src/main.ts` (`routeCexEventToCryptoStore`) →
  `packages/application/market-state/src/CryptoMarketDataStore.ts` (docs/market-state.md)
- ADR: `docs/architecture/boundary-contract.md` (Решение 10 — частотный класс определяет
  hot-path-vs-VO)
- План миграции, Этап 10 (общие находки) и Этап 11:
  `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`

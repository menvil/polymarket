# @polymarket/market-discovery

## Обзор

Два stateless-класса, отбирающие и ранжирующие рынки-кандидаты для торговли.

| Компонент | Роль |
|---|---|
| `MarketFilter` | Фильтрует `DiscoveredMarket[]` по `IMarketFilterConfig` (спред, ликвидность, срок до экспирации, ключевые слова) |
| `MarketScorer` | Сортирует отфильтрованные рынки: по часам до экспирации (ASC), затем ликвидности (DESC), затем `marketId` (ASC, для детерминизма) |

```typescript
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';

const filtered = new MarketFilter(config).apply(discoveredMarkets);
const ranked = new MarketScorer().scoreAndSort(filtered);
```

## Почему в Этапе 8 нет изменений кода

Оба класса читают ровно два внешних типа, оба уже пройдены другими этапами:

- **`IMarketFilterConfig`** (`@polymarket/ports`, Этап 5) — все 8 полей (`minSpread`,
  `minLiquidity`, `minTimeToExpiryHours`, ...) — пороги фильтрации, не единичные
  измеренные величины. Этап 5 явно оставил их `number` целиком ("не трогается вообще") —
  тот же прецедент, что `DetectorConfig.minSpreadAfterFees` (Этап 4).
- **`DiscoveredMarket`** (`@polymarket/ports`, `IMarketDiscoveryService.ts`, Этап 5) —
  `spread?: Decimal`, `liquidity: Decimal`, `eventStartMs?: number`. При расследовании
  Этапа 8 эти поля переоткрыты и **назначены Этапу 10**: реальные потребители вне уже
  закоммиченного Этапа 4 (`domain/cross-market/MarketPairMatcher.ts`) — целиком
  `apps/*`/`infrastructure/*` (`apps/collect-data/src/main.ts`, `apps/bot/src/main.ts`,
  `apps/bot/src/bot/{buildRecording,MarketRotation}.ts`,
  `infrastructure/polymarket/adapters/{PolymarketMarketDiscoveryAdapter,
  CryptoMarketMeta}.ts`) — ровно периметр, которым Этап 10 уже владеет по master-плану.
  Конверсия `DiscoveredMarket` реоткрывает закоммиченный Этап 5 файл — тот же паттерн, что
  уже принят для `IBookRegistry`/`BookUpdateHandler` в том же Этапе 10.

`MarketFilter.ts`/`MarketScorer.ts` уже присутствуют в Этап-0 allowlist для правила
"`decimal.js` вне `value-objects`/`math`" (`docs/migration/decimal-import-files.txt`) — их
`decimal.js`-импорты entangled с тем же отложенным `DiscoveredMarket` (`MarketFilter`
читает `.spread`/`.liquidity` напрямую; `MarketScorer` строит `Decimal`-скор из
`.expiresAt.toNumber()`/сравнивает с `.liquidity`), не самостоятельная находка — allowlist-
запись снимется вместе с миграцией `DiscoveredMarket` в Этапе 10, не раньше.

Единственная работа пакета в Этапе 8 — этот файл документации (пакет ранее не имел
`docs/` вообще; TSDoc-покрытие экспортов уже полное, `0/2` неаннотированных).

## Ссылки

- План миграции, Этап 8: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
- План миграции, Этап 10 (владелец `DiscoveredMarket`): тот же файл, раздел "Этап 10"
- `@polymarket/ports` — `IMarketFilterConfig`, `IMarketDiscoveryService.DiscoveredMarket`

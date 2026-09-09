# backfillPolymarketMeta.ts — не запускается как есть

Скрипт дописывает в header старых архивов (legacy-формат, `{t:'meta', …}`)
свежий объект рынка из Gamma — то есть добавляет **резолюцию** в датасеты,
собранные до неё. В снепшотах `2026-09-07` рынки лежат с `closed: false` и
`outcomePrices` = живые котировки; без такого прохода они непригодны для
бэктеста.

Перенесён сюда из `apps/collect-data/src` при удалении `@polymarket/exchange`.
**Три его импорта указывают на удалённый пакет** — запустить его нельзя, пока
они не переписаны:

| было | чем заменить |
| --- | --- |
| `@polymarket/exchange/dns` → `DnsOverride` | `@polymarket/dns-override` (тот же класс, переехал) |
| `@polymarket/exchange/rest` → `PolymarketMarketDataRestClient` | официальный SDK (`fetchMarket`) или прямой `fetch` к Gamma |
| `@polymarket/exchange/adapters` → `parseCryptoMeta` | разбор `resolutionSource`; см. `docs/guides/polymarket-venue-lessons.md` |

Ценность здесь — **алгоритм**, а не код: какие поля header-а переписываются,
как рынок сопоставляется с архивом, что считать успешным обогащением.

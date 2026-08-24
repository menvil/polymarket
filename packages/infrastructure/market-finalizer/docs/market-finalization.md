# Финализация V2-записей (N-004)

## Проблема

`closeSession(marketId, 'EXPIRED')` из N-003 делал всё одним действием:
закрыть подписки → снять routing → `finalizeMarket(EXPIRED)` → gzip.
После gzip зафиксированный first-line header обновить уже нельзя, а
официальные `priceToBeat`/`finalPrice` появляются в Gamma только ПОСЛЕ
конца события (лаг ~1-6 минут). Legacy решал это очередью pending
enrichment — V2 нужен явный lifecycle.

## Решение: два плана

### DATA LIFECYCLE (что происходит с файлом)

```text
ACTIVE .jsonl (append)
 │ expiresAt
 ↓ seal: буфер flushed, append-stream закрыт
SEALED .jsonl (payload заморожен; LINE 1 всё ещё перезаписывается r+)
 │ complete | timeout
 ↓ финальный header → finalize EXPIRED
.jsonl.gz (архив; header больше не меняется)
```

### CONTROL RETRY LIFECYCLE (кто и когда решает)

```text
MarketFinalizer.runOnce()          ← cadence у composition root
 │
 ├── listSessions(): ACTIVE && expiresAt <= now
 │        ↓
 ├── coordinator.beginFinalization(marketId)
 │     ├── state → FINALIZING ДО первого await (at most once)
 │     ├── recorder.sealMarket  (routing снят, датасет заморожен)
 │     ├── close market subscription
 │     └── release RTDS refs   (общие фиды соседей живут)
 │
 ├── pending: одна Gamma-попытка на проход (retry 30с, max 30 мин)
 │     ├── fetchMarket(gammaMarketId) → state/resolution/outcome prices
 │     ├── fetchEvent(event.id) → metadata (priceToBeat/finalPrice)
 │     ├── merge best-known (полученное однажды не теряется)
 │     └── header update:
 │           pending  → partial-данные записаны, архива нет
 │           complete → crypto: оба значения есть; non-crypto: сразу
 │           timeout  → бюджет исчерпан, best-known с явным статусом
 │
 └── финальный путь: header → finalizeMarket(EXPIRED) → gzip
        → coordinator.completeFinalization (identity-guard: только FINALIZING)
```

## Почему НЕ «timer → closeSession(EXPIRED) → updateMarketMeta»

После gzip первая строка неизменяема. Порядок обязан быть:
**header ПЕРЕД gzip** (PART 22/34). Seal создаёт состояние, в котором
payload уже заморожен (никакие поздние ExternalMessages в датасет не
попадают — cutoff), но header ещё writable.

## Capacity и повторное открытие (PART 3/4)

FINALIZING не занимает active-слот (`maxMarkets` считает OPENING+ACTIVE —
parity с legacy, освобождавшим слот сразу при expiry), но сессия остаётся
в реестре координатора — duplicate reopen блокируется существующим
guard-ом. Отдельный closed-markets blacklist с TTL из legacy НЕ перенесён:
до `completeFinalization` identity держит сессия, после архива кандидат
отклоняется проверкой `expiresAt <= now` (доказано тестами).

## Финальный header (PART 22-25)

`updateMarketMeta` заменяет `m` первой строки ЦЕЛИКОМ, поэтому finalizer
пересобирает ПОЛНЫЙ V2 header единым `buildCollectionHeader`
(`@polymarket/collection-coordinator`): initial-ядро (identity/outcomes/
timing/RTDS) + свежие `gammaMarket`/`gammaEvent` поверх initial +
`finalization`-раздел В ЯДРЕ:

```json
"finalization": {
  "status": "complete",
  "startedAtMs": 0,
  "finalizedAtMs": 0,
  "attempts": 2,
  "resolution": { "closed": true, "closedTime": "2026-08-24 11:41:25+00", "umaResolutionStatus": "resolved" },
  "outcomes": [
    { "label": "Up", "instrumentId": "...", "price": "1" },
    { "label": "Down", "instrumentId": "...", "price": "0" }
  ],
  "winning": { "label": "Up", "instrumentId": "..." },
  "crypto": { "priceToBeat": "78139.1880482839", "finalPrice": "78379.20527553321" }
}
```

Бюджет — тот же probe полного 16 KiB meta-конверта storage; лестница
усечения прежняя (`gammaEvent` → `gammaMarket`); критические
finalization-данные живут в ядре и переживают усечение vendor-снапшотов.
Backtest получает ответ о результате рынка из ОДНОЙ первой строки
(identity, timing, resolution, финальные цены, победитель, crypto-значения,
качество: complete/timeout + truncated).

## Vendor boundary (PART 18-21, live-характеризация 2026-08-24)

- `Event.metadata.priceToBeat/finalPrice` — JSON **numbers** →
  `extractCryptoFinalization` сохраняет точное десятичное представление
  строкой (`String(n)`, без `Number()`/`parseFloat`); строки — as-is;
- `Market.outcomes.*.price` — **DecimalString** (`"1"`/`"0"` у resolved,
  `"0.995"` до резолюции); vendor `yes`/`no` не покидают маппинг —
  `mapFinalOutcomes` отдаёт нейтральные `{label, instrumentId, price}`;
- победитель (`deriveWinningOutcome`) — ТОЛЬКО при
  `umaResolutionStatus === 'resolved'` и Decimal-однозначных ценах 1/0;
  иначе `winning` отсутствует, сохраняются статус и цены. Никакой
  самодеятельной settlement truth и никакого вычисления priceToBeat из
  записанных RTDS (PART 46).

## Отказы

| Сбой | Поведение |
| --- | --- |
| Gamma fetch (crypto, до таймаута) | FINALIZING/best-known/файл сохранены; retry следующим runOnce |
| Gamma fetch (non-crypto) | немедленный архив с initial-данными (без crypto-ожидания enrichment-а — 30 мин по умолчанию) |
| header `false` при complete | архив отложен, error-лог, retry по cadence; success не объявляется |
| header `false` при timeout/shutdown | архив best-known ПРЕДЫДУЩЕГО header-а, error-лог (явная policy) |
| `finalizeMarket(EXPIRED)` throw | терминально: без success-лога, без повторного gzip; сессия остаётся FINALIZING |

## Shutdown (PART 40/41/60)

`finalizer.close()`: запрет новых проходов → ожидание in-flight →
все FINALIZING архивируются EXPIRED best-known БЕЗ новых Gamma-запросов
(сеть не задерживает shutdown; статус `'complete'`, если условие уже
выполнено, иначе `'timeout'`). ACTIVE/OPENING рынки не трогаются — их
закроет `coordinator.close()` как SHUTDOWN. Итоговый порядок контура —
см. README.

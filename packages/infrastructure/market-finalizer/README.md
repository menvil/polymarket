# @polymarket/market-finalizer

Post-expiry финализация V2-записей (N-004): истёкшая ACTIVE-сессия
координатора переводится в FINALIZING (realtime останавливается, датасет
замораживается), обогащается свежими Gamma `Market`/`Event` через
официальный `@polymarket/client` и архивируется как EXPIRED `.jsonl.gz`
с полным финальным V2 header-ом.

## 1. Lifecycle

```text
ACTIVE
 │ expiresAt
 ↓
FINALIZING (beginFinalization: seal + teardown realtime; слот освобождён)
 │
 ├── Gamma retry (fetchMarket / fetchEvent, cadence 30с)
 ├── update LINE 1 (partial-данные тоже пишутся, status='pending')
 └── complete | timeout (30 мин по умолчанию)
        ↓
финальный header (status='complete' | 'timeout')
        ↓
finalizeMarket(EXPIRED) → .jsonl.gz → completeFinalization
```

## 2. Completion condition

- **crypto-рынок**: COMPLETE, когда официальные `priceToBeat` И
  `finalPrice` присутствуют в `Event.metadata` (parity с legacy);
- **non-crypto**: best-effort свежий Gamma-снапшот и НЕМЕДЛЕННЫЙ EXPIRED —
  без длительных resolution-watcher-ов; отказ Gamma его не задерживает;
- **timeout** (`enrichmentMaxWaitMs`, 30 мин по умолчанию): архив best-known
  данных с явным `finalization.status = 'timeout'` — вечных `.jsonl` нет.
  Legacy ждал 15 мин; live-замер 2026-08-24 показал публикацию `finalPrice`
  и после 15-й минуты (рынок 14.8 мин — resolved без finalPrice, 19.8 мин —
  полный), поэтому дефолт поднят: ожидание дёшево (слот свободен, датасет
  заморожен — один Gamma-poll в 30 с).

## 3. runOnce, а не таймеры (PART 13)

`runOnce()` — один проход: expiry-переходы due ACTIVE-сессий + максимум
ОДНА Gamma-попытка на pending рынок (cadence `enrichmentRetryMs`).
Периодичность принадлежит composition root. Конкурентные `runOnce`
разделяют один in-flight проход — двойных begin/fetch/header/gzip не
бывает. Часы инъецируются (`IClock`) — expiry/timeout тесты детерминированы.

## 4. Наблюдаемые отказы

- отказ Gamma: FINALIZING/best-known/файл сохраняются, retry следующим
  `runOnce()`;
- header update `false` при complete: архив отложен (без success-лога) до
  следующего прохода; на timeout — архив best-known предыдущего header-а
  с error-логом (явная policy);
- `finalizeMarket(EXPIRED)` throw: терминально для рынка — без success,
  без повторных gzip-попыток (retry-framework сознательно нет), сессия
  остаётся FINALIZING (identity защищена).

## 5. Shutdown (PART 40/41)

```text
stop discovery/expiry runner
      ↓
MarketFinalizer.close()      ← FINALIZING → EXPIRED best-known (БЕЗ новых Gamma-запросов)
      ↓
CollectionCoordinator.close() ← ACTIVE/OPENING → SHUTDOWN (incomplete удаляются)
      ↓
PolymarketSource.close() → ExternalMessageBus.drain()
      → ExternalMessageRecorder.close() → ExternalMessageBus.close()
```

ACTIVE рынки НЕ архивируются как EXPIRED из-за выключения приложения.
Общий bus finalizer не закрывает.

## 6. Скрипты

```bash
# live-характеризация финализационных данных Gamma (PART 62)
npx tsx packages/infrastructure/market-finalizer/scripts/characterize.ts

# полный live lifecycle: open → record → expiry → seal → enrich → gzip (~8-16 мин)
npx tsx packages/infrastructure/market-finalizer/scripts/smoke.ts
```

Подробности контракта — `docs/market-finalization.md`.

## 7. Тесты

```bash
npm test          # typecheck тестов + jest
npm run build     # tsc -b (с project references)
npm run lint:all  # eslint src + __tests__
```

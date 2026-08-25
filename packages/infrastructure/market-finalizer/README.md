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
 └── complete | timeout (60 мин по умолчанию — страховочный потолок)
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
- **timeout** (`enrichmentMaxWaitMs`, 60 мин по умолчанию): архив best-known
  данных с явным `finalization.status = 'timeout'` — вечных `.jsonl` нет.
  Это страховочный потолок, не типичное время: рынок архивируется сразу
  при complete (soak 2026-08-24, 13 рынков: медиана 7.9 мин, максимум
  18.1 мин у 15m-серий). Legacy ждал 15 мин и терял медленный хвост.
  Ожидание дёшево: слот свободен, датасет заморожен — один Gamma-poll
  в 30 с.

## 2.1. Winner-ladder (решение user 2026-08-25)

Победитель пишется в `finalization.winning` вместе с происхождением —
`{label, instrumentId, source, exact, basis?}`:

| source | Когда | exact |
| --- | --- | --- |
| `resolution` | UMA resolved + settlement-цены 1/0 | `true` |
| `official-prices` | формула рынка на официальных `finalPrice`/`priceToBeat` (`>= → Up`) | `true` |
| `recorded-twap` | зарезервировано под TWAP-канал (DERIVED COMPLETE) | `true` |
| `recorded-rtds` | приблизительно из записанного chainlink-ряда (только когда официальных данных нет) | `false` |

Complete-архив **crypto Up/Down-рынка** всегда несёт точного победителя
(ступень 1 или 2 — обе официальные цены к этому моменту есть по самому
completion-условию). Для остальных рынков победитель появляется только со
ступени 1: non-crypto архивируется НЕМЕДЛЕННО после expiry, и если UMA
ещё не резолвил, `winning` в архиве отсутствует — это штатный исход, а не
потеря данных. Подробности правила, guards и аппроксимации —
`docs/market-finalization.md`.

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

## 5. Shutdown (PART 40/41 + drain 2026-08-25)

```text
stop discovery/expiry runner
      ↓
MarketFinalizer.drain()      ← ШТАТНЫЙ wind-down: дождаться официальной
      ↓                        резолюции уже начатых финализаций (poll тем же
      ↓                        cadence до полного enrichmentMaxWaitMs-бюджета)
MarketFinalizer.close()      ← аварийный путь: FINALIZING → EXPIRED best-known
      ↓                        (БЕЗ новых Gamma-запросов); прерывает спящий drain
CollectionCoordinator.close() ← ACTIVE/OPENING → SHUTDOWN (incomplete удаляются)
      ↓
PolymarketSource.close() → ExternalMessageBus.drain()
      → ExternalMessageRecorder.close() → ExternalMessageBus.close()
```

`drain()` добавлен по находке CHECKPOINT #1: остановка процесса срезала
60-минутное окно ожидания (рынок архивировался `timeout` за 20 секунд до
реальной резолюции Gamma). Штатный wind-down теперь дожидается: каждый
pending-рынок архивируется `complete` либо `timeout` по СВОЕМУ полному
бюджету; рынок, истёкший во время drain, тоже дожидается. ACTIVE рынки
по-прежнему НЕ архивируются как EXPIRED из-за выключения приложения.
Общий bus finalizer не закрывает. Ветка timeout — зарезервированная точка
будущего TWAP-fallback (`DERIVED COMPLETE`).

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

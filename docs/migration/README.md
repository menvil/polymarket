# Миграция типов/Result: packages/domain + packages/application

Итоговый указатель по 12-этапной миграции `Decimal`/`number`/`string` → Value
Objects/branded ID и `throw` → `Result<T,E>` в `packages/domain/*` и `packages/application/*`
(план: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`). Этапы 0-11 закрывают
типизацию/документацию/ESLint-гейт; Этап 12 (UnitOfWork) — отдельная, ещё не начатая сессия
(см. ниже).

## Что сделано (Этапы 0-11)

| Этап | Область |
|---|---|
| 0 | Базис: ADR, `scripts/scan-conventions.mjs`, ESLint baseline (`warn`+allowlist) |
| 1 | `@polymarket/rolling-window`, `StrategyId`, `QueueOverflowError`, `ValidateAge`-фикс |
| 2 | `domain/market-data` + полная замена стакана (`@polymarket/orderbook`) + Trade-wiring |
| 3 | `market`/`fill` throw→Result, `Portfolio` VO-типизация, lot-based `Position`-wiring |
| 4 | `domain/cross-market` (частично — хот-путь сознательно остаётся `number`) |
| 5 | `application/ports` (резко урезан по факту находок — большинство отложено на 9/10) |
| 6 | `event-bus`/`handlers`/`orchestrators`, `publishOrThrow`-мост (снят в 10d) |
| 7 | `risk`/`use-cases`, `Ledger`-wiring, `ExecutionLinker` |
| 8 | `market-state`/`market-discovery` (крупнейший пересмотр — hot-path vs VO) |
| 9 | `strategy` (`CryptoAssetId`-подключение, `symbol`-поле удалено) |
| 10a-10d | `apps/*`/`infrastructure/*`: замена order-book, `StrategyId`/`eventStartMs`/`CryptoSignalResult.confidence` в `apps/bot/strategies/*`, `ports`-деферренные типы, снятие `publishOrThrow`-моста + физическое удаление `@polymarket/order-book` |
| 11 | Документация: доки для 10 пакетов без `docs/`, правка 4 устаревших корневых доков, этот файл, ESLint hard-gate (`error`, без allowlist) |

Полный список архитектурных решений — **13 занумерованных Решений** в
`docs/architecture/boundary-contract.md` (ADR): от границы примитив/VO (Решение 1) до
паттерна "персистентный/routing-key ≠ всё остаётся raw" (Решение 13). Каждое решение несёт
обоснование и, где применимо, конкретный числовой/структурный пример — не декларация без
опоры на код.

**Точка отсчёта** — `docs/migration/baseline.md`: полное состояние репозитория (build/test/
lint/typecheck) на коммите `0e93d039` (2026-08-01), СНЯТОЕ ДО первого изменения плана —
чтобы отличать пред-существующий долг от регрессий, внесённых самой миграцией.

**Текущие метрики долга** — `docs/migration/debt.md`/`debt.json`, воспроизводимо через
`node scripts/scan-conventions.mjs`: raw-примитивы на публичных сигнатурах, `throw` вне
`value-objects`/`math`, экспорты без TSDoc, наличие `docs/` — по пакету и суммарно.

## ESLint hard-gate (Этап 11)

Правило `@typescript-eslint/no-restricted-imports` на `decimal.js` (`.eslintrc.base.json`)
— `error` репо-wide для локального/ручного `npm run lint` (в репозитории нет CI-пайплайна
вообще — hard-gate не подразумевает автоматическое CI-принуждение, это осознанное решение
Этапа 11, не пробел). Пакетные исключения — только `packages/domain/value-objects` и
`packages/foundation/math` (`"@typescript-eslint/no-restricted-imports": "off"` в их
собственных `.eslintrc.json`). `import type Decimal` (только тип, стирается при компиляции)
разрешён везде через `allowTypeImports: true`.

**`docs/migration/decimal-import-files.txt`** — генерируется `scan-conventions.mjs`, но
роль файла изменилась с Этапа 11: это **не TODO-список на конверсию**, а **живой реестр
файлов с точечными, обоснованными исключениями** (`eslint-disable-next-line
@typescript-eslint/no-restricted-imports` на строке импорта, с комментарием, ссылающимся на
конкретное Решение ADR — 1, 11 или 13 в зависимости от причины). Список не должен стремиться
к нулю — каждая запись либо boundary-parsing/persisted-DTO/внутренняя арифметика после
VO-типизированной публичной границы (Решение 1), либо `apps/bot/src/strategies/*`'s
принятый внутренний Decimal-конвент (Решение 11), либо точная decimal-строка персистентной
записи (Решение 13).

## Три корневых планировочных документа — сознательно не тронуты

`master-plan.md`, `application-layer-plan.md`, `coordination-plan.md` (корень репозитория)
**не обновлялись и не будут обновляться в рамках этой миграции**. Это не пропуск —
расследование Этапа 11 подтвердило: все три — замороженные, однокоммитные артефакты от
2026-03-09/10 (5+ месяцев до старта этой миграции), описывающие **другой, более ранний**
планировочный процесс (первоначальная спецификация построения `packages/application/*` +
инфраструктуры, собственная нумерация "Фаза N", не пересекающаяся с "Этап N" этой
миграции). Всё, что `master-plan.md` специфицировал построить, уже существует в
репозитории — документ достиг своего состояния месяцы назад, без штатного механизма это
отметить. `coordination-plan.md` описывает пакеты, которые `boundary-contract.md`
(Решение 7) явно называет нереализуемыми в рамках этой миграции
(`@polymarket/balance-allocator`, `@polymarket/market-lifecycle`, `@polymarket/coordinator`,
`ReconcileOrdersUseCase`). Обновление любого из трёх было бы неточным — они не трекают эту
миграцию вообще.

## UnitOfWork — Этап 12, следующий, но отдельный

5 TODO по коду (`IOrderStateStore.ts:241`, `IKeyedMutex.ts:48`, `IMarketDataRecorder.ts:131`,
`ProcessFillUseCase.ts:821-822`, `PlaceOrderUseCase.ts:15,1015`) указывают на одну
архитектурную проблему — нет транзакционной границы через
Order+Portfolio+Ledger+ProcessedFill. Это concurrency/consistency-архитектура, другой род
работы и риска, чем типизация/документация Этапов 0-11. `docs/architecture/unit-of-work.md`
— реальный design-документ с конкретным предлагаемым решением — будет написан в начале
Этапа 12, отдельной сессии планирования, а не части этой миграции. Подробнее —
`docs/architecture/boundary-contract.md`, Решение 7.

## Ссылки

- ADR (13 решений): `docs/architecture/boundary-contract.md`
- Точка отсчёта: `docs/migration/baseline.md`
- Текущие метрики: `docs/migration/debt.md`, `docs/migration/debt.json`
- План миграции целиком: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`

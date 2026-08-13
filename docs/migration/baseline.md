# Baseline перед миграцией (Этап 0.1)

**Коммит:** `0e93d039` (2026-08-01, "fix(strategy): immediate stopAll() detach, real stop()
runtime boundary, dedup disposal errors") — HEAD ветки `phase-3` на момент начала Этапа 0.
**Дата снятия:** 2026-08-04.
**Команда:** `npm run build && npm run typecheck && npm test && npm run lint` по всем
workspace монорепо (точные числа пакетов — в разделах Test/Lint ниже, они разные для
разных команд из-за отсутствующих скриптов в части пакетов).
**Назначение:** зафиксировать фактическое состояние репозитория ДО каких-либо изменений
плана миграции (`/Users/menvil/.claude/plans/synthetic-swimming-heron.md`), чтобы отличать
пред-существующий долг от регрессий, внесённых последующими этапами.

---

## Build

✅ **Чисто.** `npm run build` — все пакеты собираются без ошибок и предупреждений.

## Typecheck

✅ **Чисто.** `npm run typecheck` — без ошибок по всем workspace.

## Test

✅ **Функционально чисто** — по факту 0 упавших assertion'ов. exit-код агрегатора при этом
`1` из-за двух не-тестовых причин (см. ниже), это не регрессия и не флейк.

Сводно по всем 35 пакетам со скриптом `test`: **265 test suites** (264 passed + 1 отмечен
failed — см. ниже), **7693 тестов** (7689 passed + 4 todo, **0 провалившихся assertion'ов**).

Единственная аномалия — `@polymarket/bot`: `Test Suites: 1 failed, 9 passed, 10 total` /
`Tests: 128 passed, 128 total`. Все 128 assertion'ов зелёные; один suite помечен failed
исключительно из-за предупреждения Jest о worker-процессе, который не завершился штатно
(`A worker process has failed to exit gracefully... Active timers can also cause this, ensure
that .unref() was called`). Источник — `apps/bot/__tests__/integration/backtest-multi-market.test.ts`
(интеграционный прогон бэктеста с реальным `BacktestEngine`/`EventBus`, судя по трассировке
в выводе). Требует `--detectOpenHandles` для точной локализации таймера/хендла без `.unref()`;
сам по себе не блокирует Этап 0, но стоит завести как отдельную задачу (кандидат — Этап 9/10,
когда `apps/bot` в периметре).

Два приложения не имеют скрипта `test` вообще (не сбой, а отсутствие инструментария):
`@polymarket/collect-data`, `@polymarket/pnl`. Не устранено в Этапе 0 — заведение Jest-конфига
с нуля для приложения выходит за рамки задачи 0.4 (та закрывала ESLint, не Jest); зафиксировано
здесь как известный пробел.

## Lint

### Состояние на момент снятия baseline (до правок этого же Этапа 0)

❌ `npm run lint` — exit 1. Три независимые причины:

1. **20 пакетов не имели `.eslintrc.json` вообще** — ESLint падал с фатальной `ESLint
   couldn't find a configuration file`, т.е. инструмент физически не запускался (не стилевые
   нарушения, а полное отсутствие покрытия): `apps/bot`, `apps/collect-data`, `apps/pnl`,
   `packages/application/{event-bus,handlers,market-discovery,market-state,orchestrators,ports,use-cases}`,
   `packages/domain/accounting/ledger`, `packages/domain/cross-market`,
   `packages/domain/market-data/{order-book,trade-tape}`,
   `packages/infrastructure/{backtesting,cex-market-data,in-memory}`,
   `packages/infrastructure/persistence/{data-collection,snapshot-readers}`,
   `packages/infrastructure/polymarket`.
   (`packages/application/market-state` изначально пропущен при первом проходе Задачи 0.4 —
   найден и устранён только при финальной repo-wide проверке 0.6, см. ниже.)
2. **5 пакетов не имели скрипта `lint` вообще** (тот же практический эффект — нулевое
   покрытие, но другая причина): `apps/collect-data`, `apps/pnl`,
   `packages/infrastructure/{backtesting,cex-market-data,in-memory}`.
3. **1 реальное стилевое нарушение** — `@polymarket/fill`, `FillMapper.ts:306`,
   `'effectiveTokenId' is never reassigned. Use 'const' instead (prefer-const)`.

### Состояние после Этапа 0.4/0.6 (в рамках этого же этапа, не отдельная задача)

Задача 0.4 добавила правило `no-restricted-imports` на `import Decimal from 'decimal.js'`
(`warn`, см. `docs/architecture/boundary-contract.md`, Решение 1) и одновременно устранила
пункт 1 выше (кроме пропущенного `market-state`, см. пометку там) и пункт 2 — иначе новое
правило было бы немым для этих пакетов, что противоречило бы цели Этапа 0 ("защита от
регрессий"). Эмпирически проверено прогоном `eslint` напрямую на представительной выборке:
`@polymarket/ports`, `@polymarket/cross-market` (ранее падали фатально) линтуются и
корректно показывают предупреждение на `decimal.js`; `@polymarket/value-objects`,
`@polymarket/foundation/math` (правило выключено локально) — 0 ложных срабатываний.

Включение конфига/lint-скрипта в ранее-неинструментированных пакетах вскрыло
**пред-существующий долг, ранее физически необнаруживаемый** — не только выборочно (как
предполагалось на момент первого прохода 0.4), а по всем 20 пакетам при финальной
repo-wide проверке 0.6. Итоговый список (все — механические правки без изменения
поведения, не миграционная работа; проверены `npm test`/`npx tsc --noEmit` в затронутых
пакетах до и после):

- `@polymarket/fill` — `FillMapper.ts:306` `prefer-const`.
- `@polymarket/cex-market-data` — `CcxtExchangeWatcher.ts:618`, `RestartingTask.ts:168`
  (`prefer-const`); `CcxtSymbolWatcher.ts:414` (`no-useless-catch`, no-op `try/catch (err) {
  throw err; }`).
- `@polymarket/exchange` (`packages/infrastructure/polymarket`) — 3× `no-multiple-empty-lines`
  (авто-`--fix`); `ExecutionContext.ts:8` `{}` как тип — намеренный идиом `string & {}` для
  сохранения IDE-автодополнения при открытом union (уже был `@remarks` с объяснением),
  подавлено точечно через `eslint-disable-next-line`, тип не менялся (риск непреднамеренно
  изменить семантику типа через "эквивалентную" замену выше цены вопроса); фатальная ошибка
  парсинга на `stubs/ethers/index.d.ts` — это скомпилированный артефакт (лежит рядом с `.ts`
  источником, `.d.ts`/`.js` новее `.ts` и явно исключён из `apps/collect-data`'s `predev`
  cleanup-скрипта), не входит в `tsconfig.json` пакета → добавлен в `ignorePatterns`
  локального `.eslintrc.json`, аналогично `dist/`.
- `@polymarket/event-bus` и `apps/collect-data` (`backfillPolymarketMeta.ts:412`) —
  `no-constant-condition` на `while (true) { ...; if (cond) break/return; }` — легитимный
  идиом (drain-loop / concurrency-pool worker), встретился независимо в двух пакетах →
  исправлено на уровне `.eslintrc.base.json` (`checkLoops: false`), а не точечными
  disable-комментариями, поскольку это системный стиль, а не два случайных совпадения.
- `@polymarket/handlers` (`BookUpdateHandler.ts:203`) и `apps/collect-data` (`main.ts:804`)
  — `no-multiple-empty-lines` (авто-`--fix`).
- `apps/bot` — 6× `no-multiple-empty-lines` в `main.ts` (авто-`--fix`); `main.ts:3894`
  `timer` и `AvellanedaStoikovStrategy.ts:1703,1760` `ask` — `prefer-const` (три независимых
  случая "объявлено — присвоено один раз", тот же паттерн что и `cex-market-data` выше).
- `packages/application/market-state` — отдельно от списка выше: не стилевая ошибка, а
  полностью пропущенный `.eslintrc.json` (see пункт 1 выше) — создан по тому же шаблону,
  что и остальные 19.

Почему исправлено, а не задокументировано как "вне периметра": все правки — одна строка на
файл (`let`→`const`, схлопывание пустых строк, `ignorePatterns`/`eslint-disable` на 1
намеренную идиому, конфиг вместо кода для системного `while(true)`-паттерна), доступны
только благодаря тому, что Этап 0.4 сам включил инструмент там, где он раньше не запускался
— оставлять их красными без причины противоречило бы цели Этапа 0 "каждый этап зелёный".
Это НЕ прецедент на будущее — этапы 1-11 мигрируют типы/throw/примитивы, а не лint-гигиену;
сюда попало только потому, что находки были побочным эффектом включения самого инструмента.

**Итог lint на конец Этапа 0:** `npm run lint` репо-wide — 0 ошибок (`error`), только
`warn`-уровень (новое правило `decimal.js` на 77 файлах из `decimal-import-files.txt`,
плюс пред-существующие `@typescript-eslint/no-explicit-any` в разных пакетах, не тронуты —
вне периметра Этапа 0). exit-код `npm run lint` per-workspace — `0` везде (warn не валит
сборку); при использовании `--max-warnings 0` где-либо в CI потребуется явный учёт этого
allowlist'а (сейчас нигде не используется). Финальное подтверждение — repo-wide прогон
Задачи 0.6 после всех правок выше (лог см. коммит Этапа 0).

## Как использовать этот файл

- `docs/migration/debt.md` (задача 0.2, `scripts/scan-conventions.mjs`) — метрика долга по
  пакетам, должна монотонно падать по мере прохождения этапов 1-10.
- Этот файл — точка отсчёта по `build`/`test`/`lint`/`typecheck`, не обновляется на каждом
  этапе (в отличие от `debt.md`). Если на каком-то из этапов 1-11 `test`/`lint` внезапно
  показывает НОВУЮ (не описанную здесь) красноту — это регрессия этапа, а не
  пред-существующий долг.
- Пробелы, сознательно оставленные не устранёнными в Этапе 0 (не регрессия, а известный
  факт): `apps/collect-data`/`apps/pnl` без `test`-скрипта; `@polymarket/bot`
  worker-teardown warning в `backtest-multi-market.test.ts`; `@typescript-eslint/no-explicit-any`
  warning'и во всех пакетах, где они уже были.

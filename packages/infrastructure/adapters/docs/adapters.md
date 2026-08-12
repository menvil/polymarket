# @polymarket/adapters

## Обзор

Инфраструктурные адаптеры, реализующие foundation-интерфейсы поверх конкретных third-party
библиотек (`foundation/*` обязан оставаться zero-external-dependencies; интеграция с
`pino`/etc. живёт здесь). Сегодня единственный адаптер — `PinoLoggerAdapter` (`ILogger` из
`@polymarket/logger` поверх Pino).

**Нулевые реальные потребители в репозитории** на момент Этапа 11 плана миграции
(проверено: ни один `package.json` не зависит от `@polymarket/adapters`, ни один файл не
импортирует `@polymarket/adapters`, включая `apps/bot`) — пакет существует, собирается и
тестируется, но никем не подключён.

## Где искать содержательную документацию

Класс уже задокументирован дважды в других местах — этот файл сознательно короткий
указатель, не третья копия того же материала:

- **`README.md`** (корень этого пакета) — полное описание `PinoLoggerAdapter`: IClock-
  интеграция для детерминированных timestamp'ов в paper-режиме, защита от коллизий с
  системными полями Pino, сериализация ошибок, child-логгеры, multiple transports.
- **`packages/foundation/logger/docs/PINO-ADAPTER-EXAMPLE.md`** — пример подключения со
  стороны `@polymarket/logger`.

## Ссылки

- `@polymarket/logger` — интерфейс `ILogger`, который реализует `PinoLoggerAdapter`
- ADR: `docs/architecture/boundary-contract.md`
- План миграции, Этап 11: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`

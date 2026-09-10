# @polymarket/application-events — устройство пакета

> Назначение, границы и структура — в `../README.md`. Здесь — заметки для
> сопровождающих.

## Почему отдельный пакет

До M-002.5 event contracts жили внутри `@polymarket/event-bus`, из-за чего
потребитель, которому нужен только ТИП события, тянул пакет доставки — связка
«что произошло» с «как доставляется». Извлечение (M-002.5) разорвало это:
contracts — leaf-ish application-пакет без единой зависимости на bus-слои.

## Конвенции

- один публичный contract/type — один PascalCase-файл; папки контуров —
  kebab-case;
- событие — flat discriminated union member (`{ type: 'X', ...поля }`);
  event-имена и формы заморожены до M-003;
- все ID — branded-типы из `@polymarket/ids` (после M-002.5/Commit 1 включая
  `strategyId: StrategyId`), денежные/временные поля — VO из
  `@polymarket/value-objects`;
- `ApplicationEvent.ts` — единственное место сборки union; Domain `OrderEvent`
  участвует по reference и не реэкспортируется;
- новое поколение событий одного контура — новая папка, а не расширение
  существующей: `trading-market-lifecycle/` рядом с legacy `market-lifecycle/`,
  `trading-account/` рядом с legacy `fill/` и `venue-order/`
  (см. «Два поколения lifecycle» и «Приватный контур торгового аккаунта» в
  `../README.md`). Переиспользовать имя события с другой семантикой запрещено —
  потребители legacy-события молча получили бы чужие данные;
- публичный контур (`market-data/`, `trading-market-lifecycle/`) и приватный
  (`trading-account/`) не смешиваются: первый описывает наблюдения, доступные
  любому участнику рынка, второй — факты о нашем аккаунте. Это разные
  read-model (`TradingHotState` и `AccountHotState`), и объединять их в одно
  состояние нельзя.

## Тесты

`__tests__/ApplicationEvent.types.test.ts` — compile-time контракт: членство
всех контрактов в union, discriminated narrowing, участие `OrderEvent`,
публичные exports корня, типизация payload'ов приватного контура
(`Portfolio`/`Order`/`Fill` вместо DTO). Runtime-поведения у пакета нет —
behavioral-тесты доставки живут в `@polymarket/event-bus` (M-000 suite), а
поведение приватной проекции — в `@polymarket/account-state`.

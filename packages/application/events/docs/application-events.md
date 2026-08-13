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
  участвует по reference и не реэкспортируется.

## Тесты

`__tests__/ApplicationEvent.types.test.ts` — compile-time контракт: членство
всех контрактов в union, discriminated narrowing, участие `OrderEvent`,
публичные exports корня. Runtime-поведения у пакета нет — behavioral-тесты
доставки живут в `@polymarket/event-bus` (M-000 suite).

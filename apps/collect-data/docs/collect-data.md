# @polymarket/collect-data

## Обзор

Автономный сборщик рыночных данных Polymarket без торговой логики — подписывается на WS-
события выбранных рынков и пишет NDJSON-снапшоты на диск (для последующего реплея через
`@polymarket/backtesting`) — плюс набор CLI-инструментов анализа собранных CEX/Chainlink-
данных, используемых при калибровке crypto-сигналов стратегий.

| Файл | Назначение |
|---|---|
| `main.ts` | Основной data-collector: дискавери рынков → WS-подписка → `DataRecorder` на диск |
| `config.ts` | `CollectorConfig` — загрузка настроек из `.env`, throw при отсутствии обязательной переменной |
| `analyzeChainlinkLeadLag.ts` | CLI: корреляционный анализ lead-lag CEX microprice vs Chainlink-цена BTC |
| `fitChainlinkLinearModels.ts` | CLI: Ridge-регрессия по тем же данным — веса бирж, горизонт предсказания |
| `checkCexSnapshot.ts` | CLI: валидация качества CEX JSONL.GZ снапшотов (gaps, crossed book, покрытие) |
| `backfillPolymarketMeta.ts` | CLI: перезаписывает meta-строку уже архивных снапшотов задним числом |

```bash
# Dev (hot-reload):
npm run dev -w @polymarket/collect-data

# Production:
npm run build -w @polymarket/collect-data && npm start -w @polymarket/collect-data
```

## `main.ts` — алгоритм сбора

1. Загрузить `.env` → `CollectorConfig`.
2. Инициализировать `DataRecorder` (`@polymarket/data-collection`), WS-адаптер, discovery
   (`PolymarketMarketDiscoveryAdapter`).
3. Начальный discovery → зарегистрировать найденные рынки + подписаться на WS.
4. Периодическое пересканирование (`MARKET_SCAN_PAUSE_MS`) — находит новые рынки, регистрирует.
5. Периодическая проверка истечений (60с) — финализирует истёкшие рынки, отписывается от WS.
6. Graceful shutdown (SIGINT/SIGTERM) — останавливает feed, закрывает recorder, отключает WS.

Фильтрация кандидатов рынков — `MarketFilter`+`MarketScorer` из `@polymarket/market-discovery`
(та же логика, что использует `apps/bot` для выбора рынков к торговле — здесь без
последующей торговли, только для решения, какие WS-потоки писать на диск).

## CLI-инструменты калибровки crypto-сигналов

`analyzeChainlinkLeadLag.ts`/`fitChainlinkLinearModels.ts` — оффлайн-анализ записанных CEX+
Chainlink снапшотов для калибровки сигнала `cex_chainlink_lead_lag` в `CryptoSignalRegistry`
(`@polymarket/market-state`): первый оценивает предсказательную силу microprice отдельных
бирж простой корреляцией, второй строит Ridge-регрессионные модели (одно-venue/комбо-venue/
aggregate) поверх тех же входных окон — получают веса бирж для weighted microprice и
устойчивость коэффициентов по времени (out-of-sample). Оба — оффлайн research-инструменты,
результат калибровки переносится в конфигурацию стратегии вручную, не автоматически.

`checkCexSnapshot.ts` — предварительная диагностика перед прогоном анализа: невалидный
JSON/отсутствующие поля, crossed orderbook, нарушение сортировки уровней, non-monotonic
timestamp, покрытие символа сделками (zero-trade файлы).

## Ссылки

- `@polymarket/data-collection` (docs/data-collection.md) — запись снапшотов на диск
- `@polymarket/cex-market-data` (docs/cex-market-data.md) — источник CEX-данных
- `@polymarket/market-discovery` (docs/market-discovery.md) — `MarketFilter`/`MarketScorer`
- ADR: `docs/architecture/boundary-contract.md`
- План миграции, Этап 11: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`

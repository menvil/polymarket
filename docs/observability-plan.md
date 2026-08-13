# Observability Plan

## Три слоя наблюдения

| Слой | Вопрос | Инструмент |
|---|---|---|
| **Operational** | Система работает? Здорова? | OTel → Prometheus/Grafana |
| **Causal** | Почему появился этот ордер? | OTel traces → Jaeger |
| **Analytical** | При каких условиях я зарабатываю? | Decision log → DuckDB |

Datadog закрывает все три — но платно. План в двух фазах.

---

## Что даёт каждый инструмент

### OTel (бесплатно, vendor-neutral)

- Полная causal chain с latency: `BOOK_UPDATED → STRATEGY_SIGNAL → ORDER_PLACED → FILL_RECEIVED`
- Экспортируется куда угодно: Jaeger (dev), Prometheus (metrics), Datadog (prod)
- Пишешь один раз — меняешь только backend

### DogStatsD

- UDP метрики в Datadog Agent (fire-and-forget, не блокирует event loop)
- Нужен **платный Datadog** — без него данные некуда падать
- Преимущество: нативная интеграция с Datadog dashboards, аномалии, алерты

### Datadog (платный)

- APM: flame graphs, service map, error tracking
- Custom metrics через DogStatsD
- Logs с трейсами коррелируются автоматически
- Имеет смысл когда система приносит деньги

---

## Фаза 1 — Dev-ready (бесплатно)

**Результат:** causal tracing в Jaeger, operational metrics в Grafana, decision log в JSONL.

**Условие для запуска:** активный trading bot с OrderBus/EventBus и реальными событиями
(STRATEGY_SIGNAL, ORDER_PLACED, FILL_RECEIVED).

---

### Шаг 1 — Новый пакет `@polymarket/telemetry`

**Создать:** `packages/infrastructure/telemetry/`

```
packages/infrastructure/telemetry/
├── package.json
├── tsconfig.json
└── src/
    ├── bootstrap.ts       ← инициализация OTel SDK (вызывается до всего)
    ├── metrics.ts         ← все counters/histograms/gauges системы
    └── index.ts
```

**Установить:**

```
@opentelemetry/api
@opentelemetry/sdk-node
@opentelemetry/exporter-trace-otlp-http   ← трейсы → Jaeger
@opentelemetry/exporter-prometheus         ← метрики → Prometheus
@opentelemetry/sdk-metrics
@opentelemetry/resources
@opentelemetry/semantic-conventions
```

`bootstrap.ts` инициализирует:

- TraceProvider → OTLP → Jaeger (`http://localhost:4318/v1/traces`)
- MeterProvider → Prometheus scrape endpoint (`http://localhost:9464/metrics`)

---

### Шаг 2 — Инициализация в точке входа

**Изменить:** `packages/apps/collect-data/src/main.ts`

Первой строкой, до всех остальных импортов:

```typescript
import '@polymarket/telemetry/bootstrap'; // side-effect import
// ... остальные импорты
```

Важно: OTel должен загрузиться до того как любой другой код создаст tracer/meter.

---

### Шаг 3 — Инструментирование EventBus

**Изменить:** `packages/application/event-bus/src/EventBus.ts`

В `_dispatch()` обернуть в OTel span:

```typescript
// Трейсы — causal chain:
tracer.startActiveSpan(`event.${event.type}`, async (span) => {
  span.setAttribute('event.type', event.type);
  // ... existing dispatch logic
  span.end();
});

// Метрики — operational:
dispatchDuration.record(elapsed, { event_type: event.type });
```

В `publish()` обновлять gauge:

```
event_bus_queue_size   ← gauge, обновлять при каждом push/shift
```

**Добавить `@opentelemetry/api` в dependencies** пакета `event-bus`.

---

### Шаг 4 — Span attributes в ключевых handlers

**Изменить** (по одной строке в каждом):

`FillEventHandler.ts`:

```typescript
trace.getActiveSpan()?.setAttributes({
  'fill.id': String(fill.id),
  'fill.side': fill.side,
  'order.id': String(fill.orderId),
});
```

`BookUpdateHandler.ts`:

```typescript
trace.getActiveSpan()?.setAttributes({
  'market.id': String(marketId),
  'book.best_bid': bestBid,
  'book.best_ask': bestAsk,
});
```

---

### Шаг 5 — Decision Logger

**Создать:** `packages/application/handlers/src/DecisionLogger.ts`

Подписывается на события через `IEventBus`, пишет `decisions-YYYY-MM-DD.jsonl`.

| Событие | Что пишем |
|---|---|
| `STRATEGY_SIGNAL` | `{ts, traceId, strategyId, instrumentId, signal, suggestedPrice, suggestedSize}` |
| `ORDER_PLACED` | `{orderId, price, size, side, marketId}` |
| `FILL_RECEIVED` | `{fillId, orderId, fillPrice, size, fee}` |
| `RISK_LIMIT_BREACHED` | `{ts, violationType, strategyId}` |

`traceId` берётся из OTel `context.active()` — автоматически связывает лог с Jaeger trace.

---

### Шаг 6 — Docker Compose

**Создать:** `docker-compose.observability.yml` в корне

```yaml
jaeger:          # трейсы, UI: localhost:16686
  image: jaegertracing/all-in-one:latest
  ports: [4318, 16686]

prometheus:      # метрики, scrape: localhost:9464
  image: prom/prometheus:latest

grafana:         # дашборды, UI: localhost:3000
  image: grafana/grafana:latest
  datasources: [prometheus, jaeger]
```

---

### Шаг 7 — Grafana дашборд

**Создать:** `grafana/dashboards/trading-bot.json`

Panels:

- Event throughput by type (events/sec)
- EventBus queue size (gauge)
- Dispatch latency P50/P95/P99 by event type
- WS reconnects over time
- Orders placed / fills received rate
- Decision to fill latency

---

### Operational метрики которые собираем

```
event_bus_queue_size              gauge    — очередь растёт?
event_dispatch_latency_ms         hist     — время обработки по event type
ws_reconnects_total               counter  — стабильность WS
strategy_signals_total            counter  — сигналов в секунду
orders_placed_total               counter  — ордеров в секунду
fill_to_order_latency_ms          hist     — от ордера до fill
active_markets_count              gauge    — сколько рынков мониторим
```

---

## Фаза 2 — Production-ready (когда система зарабатывает)

---

### Шаг 1 — DuckDB для decision analytics

**Создать:** `packages/apps/analytics/`

```sql
-- Win rate по условиям:
SELECT price_bucket, signal, COUNT(*),
       SUM(pnl > 0)::float/COUNT(*) as win_rate, AVG(pnl) as avg_pnl
FROM decisions WHERE pnl IS NOT NULL
GROUP BY 1, 2 ORDER BY win_rate DESC;

-- Decision latency percentiles:
SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY decision_ms) p50,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY decision_ms) p95
FROM decisions;

-- P&L attribution по стратегии:
SELECT strategy_id, SUM(pnl), COUNT(*) FROM decisions GROUP BY 1;
```

---

### Шаг 2 — Переключение на Datadog

**Изменить только:** `packages/infrastructure/telemetry/src/bootstrap.ts`

```typescript
// Было (Jaeger):
new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' })

// Стало (Datadog):
new OTLPTraceExporter({ url: 'https://trace.agent.datadoghq.com' })
// + DD_API_KEY в env
```

EventBus, handlers, DecisionLogger — не трогаем вообще.

---

### Шаг 3 — DogStatsD для высокочастотных метрик

**Добавить в `@polymarket/telemetry`:** `src/dogstatsd.ts`

DogStatsD для BOOK_UPDATED (может быть 1000/sec) — UDP, fire-and-forget, минимальный overhead.

---

### Шаг 4 — Alerts в Datadog

- `event_bus_queue_size > 1000` → alert "EventBus backpressure"
- `ws_reconnects > 5 за 5 минут` → alert "WS нестабилен"
- `fill_latency_p95 > 500ms` → alert "Исполнение деградировало"
- `risk_limit_breached_total` → alert немедленно

---

## Сводка

| Фаза | Время | Стоимость | Результат |
|---|---|---|---|
| **1** | 2-3 дня | $0 | Tracing + dashboards + decision log |
| **2** | 1 день | $15+/мес | Production observability + analytics |

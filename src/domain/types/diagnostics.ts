/**
 * Типы для системной диагностики
 *
 * @remarks
 * Определяет контракты для health checks, metrics, state snapshots.
 */

/**
 * Статус здоровья компонента системы
 */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/**
 * Health check результат для компонента
 */
export interface ComponentHealth {
  /** Имя компонента */
  name: string;
  /** Статус здоровья */
  status: HealthStatus;
  /** Дополнительное сообщение */
  message?: string;
  /** Детали (опционально) */
  details?: Record<string, unknown>;
  /** Timestamp проверки */
  timestamp: Date;
}

/**
 * Общий health статус системы
 */
export interface SystemHealth {
  /** Общий статус системы */
  status: HealthStatus;
  /** Health checks компонентов */
  components: ComponentHealth[];
  /** Timestamp снимка */
  timestamp: Date;
}

/**
 * Execution метрики (из MetricsProjector)
 */
export interface ExecutionMetrics {
  /** Количество размещённых ордеров */
  ordersPlaced: number;
  /** Количество исполненных ордеров */
  ordersFilled: number;
  /** Количество отклонённых ордеров */
  ordersRejected: number;
  /** Fill rate (ordersFilled / ordersPlaced) */
  fillRate: number;
}

/**
 * EventBus метрики
 */
export interface EventBusMetrics {
  /** Количество подписчиков на конкретные события */
  totalSubscribers: number;
  /** Количество подписчиков на все события */
  allEventsSubscribers: number;
  /** Подписчики по типам событий */
  subscribersByEvent: Record<string, number>;
}


/**
 * Adapters health статус
 */
export interface AdaptersHealth {
  /** ExecutionAdapter статус */
  executionAdapter: {
    available: boolean;
    message?: string;
  };
  /** PortfolioAdapter статус */
  portfolioAdapter: {
    available: boolean;
    message?: string;
  };
  /** MarketDataFeed статус */
  marketDataFeed: {
    available: boolean;
    message?: string;
  };
}

/**
 * State snapshot - текущее состояние системы
 */
export interface StateSnapshot {
  /** Количество активных ордеров */
  activeOrders: number;
  /** Количество отслеживаемых маркетов */
  trackedMarkets: number;
  /** Количество подписок */
  subscriptions: {
    orderbook: number;
    trades: number;
    userEvents: number;
  };
  /** Timestamp снимка */
  timestamp: Date;
}

/**
 * Полный diagnostics snapshot
 */
export interface DiagnosticsSnapshot {
  /** System health */
  health: SystemHealth;
  /** Execution метрики */
  executionMetrics: ExecutionMetrics;
  /** EventBus метрики */
  eventBusMetrics: EventBusMetrics;
  /** Adapters health */
  adaptersHealth: AdaptersHealth;
  /** State snapshot */
  state: StateSnapshot;
  /** Timestamp снимка */
  timestamp: Date;
}

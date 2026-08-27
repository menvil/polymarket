/**
 * Фикстуры и хелперы тестов CEX semantic-адаптера.
 *
 * @remarks
 * Payload собираются в ТОЧНОЙ форме, которую публикует `CexSource`:
 * `{ exchangeId, marketType, symbol, orderBook | trade }`, где вложенный
 * объект — unified-снапшот CCXT с его собственными именами полей и
 * значениями-числами. Это принципиально: тесты обязаны проверять контракт,
 * который реально приходит на шину, а не удобную выдуманную форму.
 *
 * Именно поэтому уровни стакана здесь — массивы `[price, amount]` с JS
 * `number`, а не строки: так их отдаёт CCXT и так они лежат в записанном
 * raw-архиве (см. `replay-parity.test.ts`).
 */
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { EventBus } from '@polymarket/event-bus';
import type { EventBusEvent } from '@polymarket/event-bus';
import { LiveClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import type { CexExternalMessage, CexMarketType } from '@polymarket/cex-v2';
import { CexSemanticAdapter } from '../../src/index.js';

/** Логгер, который ничего не пишет — тесты не зависят от вывода. */
export function silentLogger(): ILogger {
  const sink: ILogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    child: () => sink,
  };
  return sink;
}

/** Уровень стакана в source-native виде CCXT: `[price, amount]`. */
export type RawLevelFixture = readonly unknown[];

/** Параметры сборки наблюдения стакана. */
export interface OrderbookFixture {
  readonly exchangeId?: string;
  readonly marketType?: CexMarketType;
  readonly symbol?: string;
  readonly bids?: readonly RawLevelFixture[] | undefined;
  readonly asks?: readonly RawLevelFixture[] | undefined;
  readonly timestamp?: number | null;
  readonly nonce?: number | null;
}

/** Параметры сборки наблюдения сделки. */
export interface TradeFixture {
  readonly exchangeId?: string;
  readonly marketType?: CexMarketType;
  readonly symbol?: string;
  readonly id?: unknown;
  readonly side?: unknown;
  readonly price?: unknown;
  readonly amount?: unknown;
  readonly cost?: unknown;
  readonly timestamp?: number | null;
}

/**
 * Собирает payload наблюдения стакана в форме `CexSource`.
 *
 * @param fixture - Переопределения полей (остальное — реалистичные значения)
 * @returns Payload `CEX_ORDERBOOK`
 *
 * @example
 * ```typescript
 * orderbookPayload({ bids: [[100, 5]], asks: [[101, 7]] });
 * ```
 */
export function orderbookPayload(
  fixture: OrderbookFixture = {},
): Extract<CexExternalMessage, { type: 'CEX_ORDERBOOK' }>['payload'] {
  const symbol = fixture.symbol ?? 'BTC/USDT';
  const orderBook: Record<string, unknown> = {
    symbol,
    bids: fixture.bids ?? [[79233.99, 0.79752]],
    asks: fixture.asks ?? [[79234, 4.35384]],
    timestamp: fixture.timestamp === undefined ? 1787668500014 : fixture.timestamp,
    datetime: '2026-08-25T14:35:00.014Z',
  };
  if (fixture.nonce !== undefined) orderBook['nonce'] = fixture.nonce;
  return {
    exchangeId: fixture.exchangeId ?? 'binance',
    marketType: fixture.marketType ?? 'spot',
    symbol,
    orderBook,
  };
}

/**
 * Собирает payload наблюдения сделки в форме `CexSource`.
 *
 * @param fixture - Переопределения полей
 * @returns Payload `CEX_TRADE`
 *
 * @remarks
 * Поля, переданные явным `undefined`, ИЗ ОБЪЕКТА УДАЛЯЮТСЯ — иначе тест
 * «сделка без id» проверял бы наличие ключа со значением `undefined`, а не
 * реальное отсутствие поля в снапшоте vendor-а.
 */
export function tradePayload(
  fixture: TradeFixture = {},
): Extract<CexExternalMessage, { type: 'CEX_TRADE' }>['payload'] {
  const symbol = fixture.symbol ?? 'BTC/USDT';
  const trade: Record<string, unknown> = {
    symbol,
    datetime: '2026-08-25T14:30:00.176Z',
    info: { raw: 'vendor-specific' },
    fee: {},
    fees: [],
  };
  const optional: Record<string, unknown> = {
    id: 'id' in fixture ? fixture.id : '6617804453',
    side: 'side' in fixture ? fixture.side : 'buy',
    price: 'price' in fixture ? fixture.price : 79211.89,
    amount: 'amount' in fixture ? fixture.amount : 0.00115,
    cost: 'cost' in fixture ? fixture.cost : 91.0936735,
    timestamp: 'timestamp' in fixture ? fixture.timestamp : 1787668200176,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) trade[key] = value;
  }
  return {
    exchangeId: fixture.exchangeId ?? 'binance',
    marketType: fixture.marketType ?? 'spot',
    symbol,
    trade,
  };
}

/** Собранный тестовый контур: raw-шина + Application-шина + адаптер. */
export interface Harness {
  readonly bus: ExternalMessageBus<CexExternalMessage>;
  readonly eventBus: EventBus;
  readonly adapter: CexSemanticAdapter;
  readonly metadataGenerator: MessageMetadataGenerator;
  /** Все события, дошедшие до Application-шины, в порядке доставки. */
  readonly published: EventBusEvent[];
  /** События одного типа. */
  eventsOfType<K extends EventBusEvent['type']>(type: K): Extract<EventBusEvent, { type: K }>[];
  /** Публикует наблюдение стакана и дожидается обработки. */
  publishBook(fixture?: OrderbookFixture): Promise<void>;
  /** Публикует наблюдение сделки и дожидается обработки. */
  publishTrade(fixture?: TradeFixture): Promise<void>;
}

/**
 * Собирает тестовый контур и запускает адаптер.
 *
 * @param options - Опции сборки
 * @param options.autoStart - Запускать ли адаптер сразу (по умолчанию `true`)
 * @param options.recentTradeIdsCapacity - Ёмкость окна дедупа сделок
 * @returns Собранный {@link Harness}
 *
 * @remarks
 * Используются НАСТОЯЩИЕ `ExternalMessageBus` и `EventBus`, а не моки:
 * проверяется реальное поведение доставки (веерная раздача, изоляция
 * обработчиков, порядок), ради которого адаптер и построен как независимый
 * потребитель шины.
 *
 * @example
 * ```typescript
 * const h = createHarness();
 * await h.publishBook({ bids: [[100, 5]], asks: [[101, 7]] });
 * expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
 * ```
 */
export function createHarness(
  options: { autoStart?: boolean; recentTradeIdsCapacity?: number } = {},
): Harness {
  const bus = new ExternalMessageBus<CexExternalMessage>();
  const eventBus = new EventBus(silentLogger());
  const metadataGenerator = new MessageMetadataGenerator({ clock: new LiveClock() });
  const published: EventBusEvent[] = [];

  for (const type of ['BOOK_DEPTH', 'BOOK_UPDATED', 'TRADE_RECEIVED'] as const) {
    eventBus.subscribe(type, (event) => {
      published.push(event);
    });
  }

  const adapter = new CexSemanticAdapter({
    bus,
    eventBus,
    metadataGenerator,
    logger: silentLogger(),
    ...(options.recentTradeIdsCapacity !== undefined
      ? { recentTradeIdsCapacity: options.recentTradeIdsCapacity }
      : {}),
  });
  if (options.autoStart !== false) {
    adapter.start();
  }

  return {
    bus,
    eventBus,
    adapter,
    metadataGenerator,
    published,
    eventsOfType<K extends EventBusEvent['type']>(type: K): Extract<EventBusEvent, { type: K }>[] {
      return published.filter((event): event is Extract<EventBusEvent, { type: K }> =>
        event.type === type,
      );
    },
    async publishBook(fixture: OrderbookFixture = {}): Promise<void> {
      await bus.publish({
        type: 'CEX_ORDERBOOK',
        payload: orderbookPayload(fixture),
        metadata: metadataGenerator.nextRoot(),
      });
    },
    async publishTrade(fixture: TradeFixture = {}): Promise<void> {
      await bus.publish({
        type: 'CEX_TRADE',
        payload: tradePayload(fixture),
        metadata: metadataGenerator.nextRoot(),
      });
    },
  };
}

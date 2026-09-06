/**
 * Надзор за непрерывностью RTDS-потоков: молчащий или штатно завершившийся
 * фид поднимается заново, а не исчезает бесследно.
 *
 * @remarks
 * Дефект, ради которого написан надзор, найден живым прогоном 2026-09-06:
 * RTDS замолчал на 64-й минуте, десять минут рынки писались без единой
 * котировки, `pmRtdsFeeds` держался равным 6, ошибок в логе — ноль. Поэтому
 * тесты проверяют не «есть ли ошибка», а «поднялся ли поток заново».
 *
 * Bus — РЕАЛЬНЫЙ `ExternalMessageBus`; fake только граница SDK.
 */
import { describe, it, expect } from '@jest/globals';
import { LiveClock } from '@polymarket/time';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { PolymarketSource } from '../src/index.js';
import type { PolymarketExternalMessage } from '../src/index.js';
import { CapturingLogger, FakePolymarketClient, flushAsync } from './helpers/fakes.js';
import { TOKEN_ID_UP, createBinanceEvent, createBookEvent } from './helpers/sdkFixtures.js';

/** Порог молчания в тестах: короткий, чтобы надзор срабатывал детерминированно. */
const STALL_MS = 60;

/**
 * Лестница переподписки в тестах: та же ФОРМА, что в production (четыре
 * ступени с плато на последней), но в сотни раз короче. Проверяется поведение
 * лестницы, а не её абсолютные величины.
 */
const BACKOFF_MS = [10, 20, 30, 40] as const;

interface Harness {
  readonly client: FakePolymarketClient;
  readonly bus: ExternalMessageBus<PolymarketExternalMessage>;
  readonly logger: CapturingLogger;
  readonly source: PolymarketSource;
  readonly received: PolymarketExternalMessage[];
}

/** Собирает источник с коротким порогом надзора. */
function createHarness(stallAfterMs = STALL_MS): Harness {
  const client = new FakePolymarketClient();
  const bus = new ExternalMessageBus<PolymarketExternalMessage>();
  const logger = new CapturingLogger();
  const source = new PolymarketSource({
    client,
    bus,
    metadataGenerator: new MessageMetadataGenerator({ clock: new LiveClock() }),
    logger,
    rtdsStallAfterMs: stallAfterMs,
    rtdsResubscribeBackoffMs: BACKOFF_MS,
  });
  const received: PolymarketExternalMessage[] = [];
  bus.subscribe('POLYMARKET_CRYPTO_BINANCE', (m) => void received.push(m));
  bus.subscribe('POLYMARKET_MARKET', (m) => void received.push(m));
  return { client, bus, logger, source, received };
}

/** Ждёт условие, не завися от числа микротактов. */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor: условие не наступило');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe('RTDS-поток, завершившийся штатно, поднимается заново', () => {
  it('сервер закрыл поток без ошибки → новая подписка тем же spec-ом', async () => {
    const { client, source, received } = createHarness();
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);
    client.cryptoHandles[0]?.emit(createBinanceEvent());
    await flushAsync();
    expect(received).toHaveLength(1);

    // Ровно наблюдённый дефект: итератор кончился, исключения нет.
    client.cryptoHandles[0]?.endFromServer();
    await waitFor(() => client.cryptoHandles.length === 2);

    // Spec переподписки совпадает с исходным — иначе фид «поднялся» бы не тот.
    expect(client.subscribeCalls[1]).toEqual([
      { topic: 'prices.crypto.binance', symbols: ['btcusdt'] },
    ]);
    // И данные снова текут — через ТОТ ЖЕ объект подписки у владельца.
    client.cryptoHandles[1]?.emit(createBinanceEvent());
    await flushAsync();
    expect(received).toHaveLength(2);

    await source.close();
  });

  it('счётчик перезапусков и момент последнего события видны в диагностике', async () => {
    const { client, source } = createHarness();
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);
    client.cryptoHandles[0]?.emit(createBinanceEvent());
    await flushAsync();

    expect(source.getSubscriptionHealth()).toEqual([
      expect.objectContaining({
        subscription: 'prices.crypto.binance\nbtcusdt',
        restarts: 0,
        broken: false,
      }),
    ]);
    expect(source.getSubscriptionHealth()[0]?.lastEventAtMs).toEqual(expect.any(Number));

    client.cryptoHandles[0]?.endFromServer();
    await waitFor(() => source.getSubscriptionHealth()[0]?.restarts === 1);

    await source.close();
  });
});

describe('молчащий RTDS-поток перезапускается по watchdog', () => {
  it('нет событий дольше порога → поток закрыт и поднят заново', async () => {
    const { client, source, logger } = createHarness();
    await source.subscribeCryptoPrices('prices.crypto.chainlink', ['btc/usd']);
    client.cryptoHandles[0]?.emit(createBinanceEvent());
    await flushAsync();

    // Никаких событий: транспорт «жив», но данных нет — тот самый сценарий,
    // который ref-count подписок заметить не в состоянии.
    await waitFor(() => client.cryptoHandles.length === 2);

    expect(client.cryptoHandles[0]?.closeCalls).toBe(1);
    expect(
      logger.entries.some(
        (e) => e.level === 'warn' && e.message.includes('went silent, restarting'),
      ),
    ).toBe(true);
    expect(source.getSubscriptionHealth()[0]?.restarts).toBe(1);

    await source.close();
  });

  it('подписка, не принёсшая НИ ОДНОГО события, тоже считается мёртвой', async () => {
    const { client, source } = createHarness();
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

    await waitFor(() => client.cryptoHandles.length === 2);

    await source.close();
  });

  it('поток с событиями чаще порога НЕ перезапускается', async () => {
    const { client, source } = createHarness();
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

    const until = Date.now() + STALL_MS * 4;
    while (Date.now() < until) {
      client.cryptoHandles[0]?.emit(createBinanceEvent());
      await new Promise<void>((resolve) => setTimeout(resolve, STALL_MS / 4));
    }
    await flushAsync();

    expect(client.cryptoHandles).toHaveLength(1);
    expect(source.getSubscriptionHealth()[0]?.restarts).toBe(0);

    await source.close();
  });
});

describe('надзор не мешает штатному владению подпиской', () => {
  it('close() владельца НЕ поднимает поток заново', async () => {
    const { client, source } = createHarness();
    const subscription = await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

    await subscription.close();
    await new Promise<void>((resolve) => setTimeout(resolve, STALL_MS * 3));

    expect(client.cryptoHandles).toHaveLength(1);
    expect(source.getSubscriptionHealth()).toEqual([]);

    await source.close();
  });

  it('close() источника не оставляет переподписок', async () => {
    const { client, source } = createHarness();
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);
    await source.subscribeChainlinkTwap(60, ['btc/usd']);

    await source.close();
    await new Promise<void>((resolve) => setTimeout(resolve, STALL_MS * 3));

    expect(client.cryptoHandles).toHaveLength(1);
    expect(client.twapHandles).toHaveLength(1);
    expect(source.isClosed).toBe(true);
  });

  it('CLOB-подписка НЕ надзирается: тихий рынок это норма', async () => {
    const { client, source } = createHarness();
    await source.subscribeMarket([TOKEN_ID_UP]);
    client.marketHandles[0]?.emit(createBookEvent());
    await flushAsync();

    // Молчим дольше порога — market-подписка перезапускаться не должна.
    await new Promise<void>((resolve) => setTimeout(resolve, STALL_MS * 4));

    expect(client.marketHandles).toHaveLength(1);
    expect(source.getSubscriptionHealth()).toEqual([]);

    await source.close();
  });
});


describe('сломанный фид остаётся наблюдаемым и восстанавливается', () => {
  it('после исчерпания лестницы фид broken, но ретраи ПРОДОЛЖАЮТСЯ и он оживает', async () => {
    // Ограниченное число попыток вернуло бы исходный дефект другим путём:
    // обрыв дольше суммы лестницы навсегда оставил бы контур без RTDS.
    const { client, source, logger, received } = createHarness(10_000);
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

    client.subscribeError = new Error('SDK transport down');
    client.cryptoHandles[0]?.endFromServer();

    await waitFor(() => source.getSubscriptionHealth()[0]?.broken === true);

    // ГЛАВНОЕ: broken виден в диагностике, а не исчезает вместе с записью.
    expect(source.getSubscriptionHealth()).toEqual([
      expect.objectContaining({ subscription: 'prices.crypto.binance\nbtcusdt', broken: true }),
    ]);
    expect(source.hasFailed).toBe(false);
    expect(
      logger.entries.some((e) => e.level === 'error' && e.message.includes('is broken')),
    ).toBe(true);

    // Сеть вернулась — фид обязан подняться сам, без вмешательства.
    const failedAttempts = client.subscribeCalls.length;
    client.subscribeError = undefined;
    await waitFor(() => client.cryptoHandles.length === 2);
    expect(client.subscribeCalls.length).toBeGreaterThan(failedAttempts);

    const health = source.getSubscriptionHealth()[0];
    expect(health?.broken).toBe(false);
    expect(health?.restarts).toBe(1);

    client.cryptoHandles[1]?.emit(createBinanceEvent());
    await flushAsync();
    expect(received.length).toBeGreaterThan(0);

    await source.close();
  });
});

describe('release владельца отменяет восстановление', () => {
  it('close() во время backoff НЕ поднимает подписку и не виснет', async () => {
    // Гонка из lifecycle: последний market-ref исчезает независимо от того,
    // переподключается ли фид прямо сейчас.
    const { client, source } = createHarness(10_000);
    const subscription = await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

    client.subscribeError = new Error('SDK transport down');
    client.cryptoHandles[0]?.endFromServer();
    // Дожидаемся, что цикл действительно ушёл в backoff.
    await waitFor(() => client.subscribeCalls.length >= 2);

    const openedBefore = client.cryptoHandles.length;
    client.subscribeError = undefined; // сеть «починилась» ровно в момент release

    const closedAt = Date.now();
    await subscription.close();

    // Ждать конец ступени backoff (10 с) close() не имеет права.
    expect(Date.now() - closedAt).toBeLessThan(1_000);
    // И ни одного нового handle: zombie-подписки не осталось.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(client.cryptoHandles).toHaveLength(openedBefore);
    expect(source.getSubscriptionHealth()).toEqual([]);

    await source.close();
  });

  it('source.close() во время backoff не ждёт ступень', async () => {
    const { client, source } = createHarness(10_000);
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

    client.subscribeError = new Error('SDK transport down');
    client.cryptoHandles[0]?.endFromServer();
    await waitFor(() => client.subscribeCalls.length >= 2);

    const closedAt = Date.now();
    await source.close();
    expect(Date.now() - closedAt).toBeLessThan(1_000);
    expect(source.isClosed).toBe(true);
  });
});

describe('identity здоровья = identity фида у контроллера', () => {
  it('шесть физических фидов дают шесть независимых записей', async () => {
    // Контроллер подписывается ПО ОДНОМУ символу (rtdsFeedKey = topic+symbol
    // [+window]). Ключ из одного topic склеил бы BTC и ETH, и завершение
    // одной подписки стирало бы диагностику другой.
    const { source } = createHarness(10_000);
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);
    await source.subscribeCryptoPrices('prices.crypto.binance', ['ethusdt']);
    await source.subscribeCryptoPrices('prices.crypto.chainlink', ['btc/usd']);
    await source.subscribeCryptoPrices('prices.crypto.chainlink', ['eth/usd']);
    await source.subscribeChainlinkTwap(60, ['btc/usd']);
    await source.subscribeChainlinkTwap(60, ['eth/usd']);

    expect(source.getSubscriptionHealth().map((h) => h.subscription)).toEqual([
      'prices.crypto.binance\nbtcusdt',
      'prices.crypto.binance\nethusdt',
      'prices.crypto.chainlink\nbtc/usd',
      'prices.crypto.chainlink\neth/usd',
      'prices.crypto.chainlink.twap\nbtc/usd\n60',
      'prices.crypto.chainlink.twap\neth/usd\n60',
    ]);

    await source.close();
  });

  it('здоровье соседа переживает завершение подписки того же topic', async () => {
    const { client, source } = createHarness(10_000);
    const btc = await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);
    await source.subscribeCryptoPrices('prices.crypto.binance', ['ethusdt']);
    client.cryptoHandles[1]?.emit(createBinanceEvent());
    await flushAsync();

    await btc.close();

    expect(source.getSubscriptionHealth()).toEqual([
      expect.objectContaining({ subscription: 'prices.crypto.binance\nethusdt' }),
    ]);
    expect(source.getSubscriptionHealth()[0]?.lastEventAtMs).toEqual(expect.any(Number));

    await source.close();
  });
});

describe('падение итератора: локально для RTDS, терминально для CLOB', () => {
  it('исключение RTDS-итератора перезапускает ФИД, а не роняет source', async () => {
    const { client, source, received } = createHarness();
    await source.subscribeMarket([TOKEN_ID_UP]);
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

    client.cryptoHandles[0]?.fail(new Error('RTDS transport connection lost'));
    await waitFor(() => client.cryptoHandles.length === 2);

    expect(source.hasFailed).toBe(false);
    expect(source.isClosed).toBe(false);
    // CLOB не тронут — ни закрытия, ни переоткрытия.
    expect(client.marketHandles).toHaveLength(1);
    expect(client.marketHandles[0]?.closeCalls).toBe(0);

    // И CLOB продолжает публиковаться после аварии соседа.
    client.marketHandles[0]?.emit(createBookEvent());
    client.cryptoHandles[1]?.emit(createBinanceEvent());
    await flushAsync();
    expect(received).toHaveLength(2);

    await source.close();
  });

  it('исключение CLOB-итератора остаётся терминальным отказом source', async () => {
    const { client, source } = createHarness(10_000);
    await source.subscribeMarket([TOKEN_ID_UP]);
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

    client.marketHandles[0]?.fail(new Error('CLOB transport connection lost'));
    await flushAsync();

    expect(source.hasFailed).toBe(true);
    expect(client.cryptoHandles[0]?.closeCalls).toBeGreaterThanOrEqual(1);

    await source.close();
  });
});

describe('release во время незавершённого reopen()', () => {
  it('handle, открывшийся ПОСЛЕ release, закрывается и не начинает качать', async () => {
    // Самая узкая гонка: ожидание backoff уже прошло, `subscribe()` ушёл в
    // сеть, и ровно в этот момент последний рынок отпускает фид. Сигнал
    // release тут уже не помогает — проверка нужна ПОСЛЕ возврата handle.
    const { client, source, received } = createHarness(10_000);
    const subscription = await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

    let releaseHold!: () => void;
    client.subscribeHold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    client.cryptoHandles[0]?.endFromServer();
    // Переподписка ушла в SDK и там застряла.
    await waitFor(() => client.subscribeCalls.length === 2);

    const closing = subscription.close();
    releaseHold(); // handle открывается уже после release
    await waitFor(() => client.cryptoHandles.length === 2);

    // close() обязан завершиться, а не ждать вечно новый pump-цикл.
    const outcome = await Promise.race([
      closing.then(() => 'closed' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000)),
    ]);
    expect(outcome).toBe('closed');

    // Поздний handle закрыт и НЕ качается: его события никуда не идут.
    expect(client.cryptoHandles[1]?.closeCalls).toBeGreaterThanOrEqual(1);
    const before = received.length;
    client.cryptoHandles[1]?.emit(createBinanceEvent());
    await flushAsync();
    expect(received).toHaveLength(before);
    expect(source.getSubscriptionHealth()).toEqual([]);

    await source.close();
  });
});

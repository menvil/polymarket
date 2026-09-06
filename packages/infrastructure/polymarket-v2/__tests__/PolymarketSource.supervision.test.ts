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
        subscription: 'prices.crypto.binance',
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

describe('отказ переподписки наблюдаем и не роняет источник', () => {
  it('исчерпанные попытки помечают фид broken, source остаётся живым', async () => {
    // Backoff-лесенка реальная (1+2+5+10 с) — берём порог побольше, чтобы
    // watchdog не вмешивался, и проверяем исход по первой же неудаче.
    const { client, source, logger } = createHarness(10_000);
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);
    await source.subscribeMarket([TOKEN_ID_UP]);

    client.subscribeError = new Error('SDK transport down');
    client.cryptoHandles[0]?.endFromServer();

    await waitFor(
      () =>
        logger.entries.some(
          (e) => e.level === 'warn' && e.message.includes('re-subscribe failed'),
        ),
      5_000,
    );

    // Отказ ОДНОГО фида не переводит источник в терминальное состояние:
    // CLOB-подписки и остальной контур продолжают работать.
    expect(source.hasFailed).toBe(false);
    expect(source.isClosed).toBe(false);

    await source.close();
  }, 20_000);
});

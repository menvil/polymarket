/**
 * Вывод RTDS-фидов крипто-рынка из normalized SDK Market.
 *
 * @remarks
 * ### Правило определения крипто-рынка (parity с legacy `parseCryptoMeta`)
 *
 * Крипто-рынок распознаётся ТОЛЬКО по `resolution.source` normalized Market
 * (тот же `resolutionSource` Gamma, что использовал legacy):
 *
 * - `https://www.binance.com/en/trade/BTC_USDT` → source `binance`;
 * - `https://data.chain.link/streams/btc-usd`   → source `chainlink`.
 *
 * Для обоих источников подписываемся на ОБА RTDS topic (Binance + Chainlink),
 * как и legacy-коллектор: Polymarket резолвит по Chainlink, а Binance-цена
 * нужна для анализа расхождений.
 *
 * ### Vendor topics V2 (сознательное отличие от legacy)
 *
 * Legacy RTDS-клиент подписывался на wire-topics `crypto_prices` /
 * `crypto_prices_chainlink`. Официальный SDK 0.6.0 переименовывает их в
 * `prices.crypto.binance` / `prices.crypto.chainlink` — здесь используются
 * SDK-имена, потому что подписку выполняет `PolymarketSource.subscribeCryptoPrices`,
 * а маршрутизацию записи — `ExternalMessageRecorder` по точному `(topic, symbol)`.
 * Символы НЕ меняются: Binance — слитный lowercase (`btcusdt`), Chainlink —
 * slash-формат (`btc/usd`). Эвристика формата символа (`symbol.includes('/')`)
 * сознательно не переносится: источник различает vendor topic.
 *
 * ### Отличия от legacy по условиям срабатывания (документированные)
 *
 * 1. Legacy `parseCryptoMeta` дополнительно требовал валидных
 *    `eventStartTime`/`endDate` — они были нужны его klines-математике, а не
 *    RTDS-подписке. V2-вывод фидов зависит ТОЛЬКО от `resolution.source`:
 *    если у крипто-рынка нет времени начала события, цены всё равно пишутся.
 * 2. Chainlink-парсер V2 дополнительно понимает TWAP-форму URL текущих
 *    5m/15m-серий (`.../streams/btc-usd-twap-60s-streams` → `btc/usd`).
 *    Legacy-регекс такие URL не парсил вовсе — старый коллектор записывал
 *    эти рынки БЕЗ RTDS-цен. Для всех URL, которые legacy умел парсить,
 *    вывод идентичен (см. parity-тесты).
 */
import type { CryptoPricesTopic } from '@polymarket/bindings/subscriptions';
import type { Market } from '@polymarket/bindings/gamma';
import { asCryptoAssetId } from '@polymarket/ids';
import type { CryptoAssetId } from '@polymarket/ids';

/**
 * Точный ключ одного RTDS-фида: vendor topic + символ в нативном формате.
 *
 * @remarks
 * Структурно совместим с `PolymarketRtdsFeedKey` recorder-а (N-002) —
 * координатор передаёт эти объекты в `registerMarket({ rtdsFeeds })`
 * без конверсии. Тип живёт здесь, потому что это словарь source-контура
 * (recorder зависит от polymarket-v2, обратная зависимость запрещена).
 */
export interface PolymarketRtdsFeed {
  /** Vendor topic RTDS SDK (`prices.crypto.binance` | `prices.crypto.chainlink`). */
  readonly topic: CryptoPricesTopic;
  /** Точный символ фида (Binance — `btcusdt`, Chainlink — `btc/usd`). */
  readonly symbol: string;
}

/**
 * Крипто-метаданные выбранного рынка: источник резолюции и его RTDS-фиды.
 */
export interface PolymarketCryptoMeta {
  /** Источник резолюции рынка из `resolution.source`. */
  readonly source: 'binance' | 'chainlink';
  /**
   * Canonical базовый криптоактив рынка (`btc`, `eth`, ...) —
   * рабочая identity `cross-market`/`market-state`
   * (`priceToBeat`/`finalPrice`); прямой вход для enrichment N-004,
   * потребителю не нужно повторно парсить vendor-символы.
   */
  readonly asset: CryptoAssetId;
  /** Символ Binance klines-формата (`BTCUSDT`) — для диагностики/enrichment N-004. */
  readonly binanceSymbol: string;
  /** RTDS-фиды рынка (оба topic, если известен маппинг символов). */
  readonly feeds: readonly PolymarketRtdsFeed[];
}

/**
 * Маппинг Chainlink-символов → Binance-символы.
 *
 * @remarks
 * Скопирован 1:1 из legacy `CryptoMarketMeta` (behavior oracle): Chainlink
 * использует `btc/usd`, Binance — `BTCUSDT`. Пары без маппинга дают только
 * односторонние подписки (как в legacy).
 *
 * Null-prototype + freeze: lookup по внешнему символу не должен находить
 * унаследованные ключи (`constructor`/`toString`), а таблица — мутироваться.
 */
const CHAINLINK_TO_BINANCE: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    'btc/usd': 'BTCUSDT',
    'eth/usd': 'ETHUSDT',
    'sol/usd': 'SOLUSDT',
    'doge/usd': 'DOGEUSDT',
    'xrp/usd': 'XRPUSDT',
    'bnb/usd': 'BNBUSDT',
    'ada/usd': 'ADAUSDT',
    'avax/usd': 'AVAXUSDT',
    'link/usd': 'LINKUSDT',
    'matic/usd': 'MATICUSDT',
    'dot/usd': 'DOTUSDT',
    'ltc/usd': 'LTCUSDT',
  }),
);

/**
 * Обратный маппинг Binance-символов → Chainlink-символы (тот же контракт
 * иммутабельности, что у {@link CHAINLINK_TO_BINANCE}).
 */
const BINANCE_TO_CHAINLINK: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, string>,
    Object.fromEntries(
      Object.entries(CHAINLINK_TO_BINANCE).map(([chainlink, binance]) => [binance, chainlink]),
    ),
  ),
);

/**
 * Выводит крипто-метаданные (RTDS-фиды) из normalized SDK Market.
 *
 * @param market - Normalized Market официального SDK (или только его
 *   `resolution.source` — используется единственное поле)
 * @returns Крипто-метаданные или `undefined` для не-крипто рынков
 *
 * @remarks
 * Правила распознавания и порядок фидов повторяют legacy `parseCryptoMeta`:
 * - binance-источник: сначала Binance-фид, затем Chainlink (если известен);
 * - chainlink-источник: сначала Chainlink-фид, затем Binance;
 * - неизвестный Chainlink-символ (нет в таблице) → рынок НЕ считается
 *   поддержанным крипто-рынком (как в legacy).
 *
 * @example
 * ```typescript
 * const meta = derivePolymarketCryptoMeta(market);
 * if (meta) {
 *   // meta.feeds → [{topic: 'prices.crypto.binance', symbol: 'btcusdt'},
 *   //               {topic: 'prices.crypto.chainlink', symbol: 'btc/usd'}]
 *   recorder.registerMarket({ marketMeta, rtdsFeeds: meta.feeds });
 * }
 * ```
 */
export function derivePolymarketCryptoMeta(
  market: Pick<Market, 'resolution'>,
): PolymarketCryptoMeta | undefined {
  const resolutionSource = market.resolution.source;
  if (resolutionSource === null || resolutionSource === undefined || resolutionSource === '') {
    return undefined;
  }

  // Binance source: https://www.binance.com/en/trade/BTC_USDT
  if (resolutionSource.includes('binance.com')) {
    const match = resolutionSource.match(/\/trade\/([A-Z]+)_([A-Z]+)/i);
    if (!match) {
      return undefined;
    }
    const base = match[1]!.toUpperCase();
    const quote = match[2]!.toUpperCase();
    const asset = asCryptoAssetId(base.toLowerCase());
    if (asset === undefined) {
      return undefined; // патологический base (>32 символов) — рынок не поддержан
    }
    const binanceSymbol = `${base}${quote}`;
    const binanceFilter = binanceSymbol.toLowerCase();
    const chainlinkFilter = BINANCE_TO_CHAINLINK[binanceSymbol];
    return {
      source: 'binance',
      asset,
      binanceSymbol,
      feeds: [
        { topic: 'prices.crypto.binance', symbol: binanceFilter },
        ...(chainlinkFilter !== undefined
          ? [{ topic: 'prices.crypto.chainlink' as const, symbol: chainlinkFilter }]
          : []),
      ],
    };
  }

  // Chainlink source: https://data.chain.link/streams/btc-usd
  // и TWAP-форма текущих 5m/15m-серий: .../streams/btc-usd-twap-60s-streams
  if (resolutionSource.includes('chain.link')) {
    const match = resolutionSource.match(/\/([a-z]+-[a-z]+)(?:-twap(?:-[a-z0-9]+)*)?$/i);
    if (!match) {
      return undefined;
    }
    const chainlinkSymbol = match[1]!.toLowerCase().replace('-', '/');
    const binanceSymbol = CHAINLINK_TO_BINANCE[chainlinkSymbol];
    if (binanceSymbol === undefined) {
      return undefined;
    }
    const asset = asCryptoAssetId(chainlinkSymbol.split('/')[0]!);
    if (asset === undefined) {
      return undefined; // недостижимо для пар из таблицы; защитный guard
    }
    return {
      source: 'chainlink',
      asset,
      binanceSymbol,
      feeds: [
        { topic: 'prices.crypto.chainlink', symbol: chainlinkSymbol },
        { topic: 'prices.crypto.binance', symbol: binanceSymbol.toLowerCase() },
      ],
    };
  }

  return undefined;
}

/**
 * Парсинг метаданных крипто-рынка из rawMarket (Gamma API).
 *
 * @remarks
 * Polymarket крипто-рынки ("Bitcoin Up or Down") резолвятся по правилу:
 * `close >= open` → UP, иначе DOWN.
 *
 * Метаданные необходимы для:
 * 1. Определения источника данных (Binance / Chainlink)
 * 2. Подписки на RTDS WebSocket для реал-тайм цен
 * 3. Получения strike/resolution price из Binance klines
 *
 * ### Источники данных:
 * - `resolutionSource` содержит `binance.com` → Binance klines + RTDS dual-subscribe
 * - `resolutionSource` содержит `chain.link` → Chainlink + RTDS dual-subscribe
 *
 * **Важно**: подписываемся на ОБА topic (`crypto_prices` + `crypto_prices_chainlink`).
 * Записываем обе цены с полем `source: 'chainlink' | 'binance'`.
 * Polymarket резолвит по Chainlink, но Binance цена полезна для анализа расхождений.
 *
 * @example
 * ```typescript
 * const meta = parseCryptoMeta(candidate.rawMarket);
 * if (meta) {
 *   rtdsClient.subscribe(meta.rtdsTopic, meta.rtdsFilter);
 *   const kline = await binanceClient.getKline(meta.binanceSymbol, meta.eventStartTimeMs, '1h');
 *   cryptoPriceStore.setTargetPrice(meta.rtdsFilter, kline.open);
 * }
 * ```
 */

/**
 * Метаданные крипто-рынка Polymarket.
 *
 * @param source - Источник данных: Binance или Chainlink
 * @param rtdsTopic - RTDS WebSocket topic для подписки
 * @param rtdsFilter - Фильтр символа в RTDS (e.g. 'btcusdt', 'btc/usd')
 * @param binanceSymbol - Символ Binance для klines API (e.g. 'BTCUSDT')
 * @param eventStartTimeMs - Время начала окна (epoch ms)
 * @param endDateMs - Время конца окна (epoch ms)
 */
/**
 * Пара topic + filter для RTDS подписки.
 */
export interface RtdsSubscription {
  readonly topic: string;
  readonly filter: string;
}

export interface CryptoMarketMeta {
  readonly source: 'binance' | 'chainlink';
  /** @deprecated Используй rtdsSubscriptions[0].topic */
  readonly rtdsTopic: string;
  /** @deprecated Используй rtdsSubscriptions[0].filter */
  readonly rtdsFilter: string;
  /**
   * Все RTDS подписки для этого символа.
   *
   * @remarks
   * Подписываемся на ОБА topic: `crypto_prices` (Binance) и `crypto_prices_chainlink`.
   * RTDS может отправлять цены только на один из них — подписка на оба гарантирует
   * получение данных для любого символа.
   */
  readonly rtdsSubscriptions: readonly RtdsSubscription[];
  readonly binanceSymbol: string;
  readonly eventStartTimeMs: number;
  readonly endDateMs: number;
  /**
   * Официальный strike price от Polymarket (eventMetadata.priceToBeat).
   *
   * @remarks
   * Доступен через Gamma API только ПОСЛЕ eventStartTime.
   * При регистрации рынка ДО старта — undefined.
   * Collect-data перезапрашивает метаданные после eventStartTime для получения.
   */
  readonly priceToBeat: number | undefined;
  /**
   * Финальная цена от Polymarket (eventMetadata.finalPrice).
   *
   * @remarks
   * Доступен через Gamma API только ПОСЛЕ endDate (закрытие рынка).
   * Chainlink цена на момент endDate — используется для resolution.
   */
  readonly finalPrice: number | undefined;
}

/**
 * Маппинг Chainlink символов → Binance символы.
 *
 * @remarks
 * Chainlink использует формат 'btc/usd', Binance — 'BTCUSDT'.
 * Маппинг нужен для запроса klines из Binance для Chainlink-based рынков.
 */
const CHAINLINK_TO_BINANCE: Record<string, string> = {
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
};

/**
 * Обратный маппинг Binance символов → Chainlink символы.
 *
 * @remarks
 * Оба RTDS topic отправляют обновления:
 * - `crypto_prices` (Binance): фильтры через comma-separated строку
 * - `crypto_prices_chainlink` (Chainlink): JSON фильтр или пустая строка (все символы)
 * Маппинг нужен для Binance-sourced рынков: `BTCUSDT` → `btc/usd`.
 */
const BINANCE_TO_CHAINLINK: Record<string, string> = Object.fromEntries(
  Object.entries(CHAINLINK_TO_BINANCE).map(([cl, bn]) => [bn, cl]),
);

/**
 * Парсит rawMarket и возвращает CryptoMarketMeta для крипто-рынков.
 *
 * @param rawMarket - Сырой объект рынка из Gamma API (через DiscoveredMarket.rawMarket)
 * @returns CryptoMarketMeta или undefined для не-крипто рынков
 *
 * @remarks
 * Определяет крипто-рынок по наличию `resolutionSource` содержащего
 * 'binance.com' или 'chain.link'. Для не-крипто рынков (политические,
 * спортивные и т.д.) возвращает undefined.
 *
 * @example
 * ```typescript
 * const meta = parseCryptoMeta({
 *   resolutionSource: 'https://www.binance.com/en/trade/BTC_USDT',
 *   eventStartTime: '2026-03-11T22:00:00Z',
 *   endDate: '2026-03-11T23:00:00Z',
 * });
 * // meta.source === 'binance'
 * // meta.binanceSymbol === 'BTCUSDT'
 * // meta.rtdsTopic === 'crypto_prices'
 * // meta.rtdsFilter === 'btcusdt'
 * ```
 */
export function parseCryptoMeta(rawMarket: Record<string, unknown> | undefined | null): CryptoMarketMeta | undefined {
  if (!rawMarket) return undefined;

  const resolutionSource = rawMarket['resolutionSource'] as string | undefined;
  if (!resolutionSource) return undefined;

  const eventStartTime = rawMarket['eventStartTime'] as string | undefined;
  const endDate = rawMarket['endDate'] as string | undefined;
  if (!eventStartTime || !endDate) return undefined;

  const eventStartTimeMs = new Date(eventStartTime).getTime();
  const endDateMs = new Date(endDate).getTime();
  if (Number.isNaN(eventStartTimeMs) || Number.isNaN(endDateMs)) return undefined;

  // Извлекаем priceToBeat и finalPrice из events[0].eventMetadata
  const eventMeta = _extractEventMetadata(rawMarket);
  const priceToBeat = eventMeta?.priceToBeat;
  const finalPrice = eventMeta?.finalPrice;

  // Binance source: https://www.binance.com/en/trade/BTC_USDT
  if (resolutionSource.includes('binance.com')) {
    const match = resolutionSource.match(/\/trade\/([A-Z]+)_([A-Z]+)/i);
    if (!match) return undefined;

    const base = match[1]!.toUpperCase();
    const quote = match[2]!.toUpperCase();
    const binanceSymbol = `${base}${quote}`;
    const binanceFilter = binanceSymbol.toLowerCase();
    const chainlinkFilter = BINANCE_TO_CHAINLINK[binanceSymbol];

    return {
      source: 'binance',
      rtdsTopic: 'crypto_prices_chainlink',
      rtdsFilter: chainlinkFilter ?? binanceFilter,
      rtdsSubscriptions: [
        { topic: 'crypto_prices', filter: binanceFilter },
        ...(chainlinkFilter ? [{ topic: 'crypto_prices_chainlink', filter: chainlinkFilter }] : []),
      ],
      binanceSymbol,
      eventStartTimeMs,
      endDateMs,
      priceToBeat,
      finalPrice,
    };
  }

  // Chainlink source: https://data.chain.link/streams/btc-usd
  if (resolutionSource.includes('chain.link')) {
    const match = resolutionSource.match(/\/([a-z]+-[a-z]+)$/i);
    if (!match) return undefined;

    const chainlinkSymbol = match[1]!.toLowerCase().replace('-', '/');
    const binanceSymbol = CHAINLINK_TO_BINANCE[chainlinkSymbol];
    if (!binanceSymbol) return undefined;
    const binanceFilter = binanceSymbol.toLowerCase();

    return {
      source: 'chainlink',
      rtdsTopic: 'crypto_prices_chainlink',
      rtdsFilter: chainlinkSymbol,
      rtdsSubscriptions: [
        { topic: 'crypto_prices_chainlink', filter: chainlinkSymbol },
        { topic: 'crypto_prices', filter: binanceFilter },
      ],
      binanceSymbol,
      eventStartTimeMs,
      endDateMs,
      priceToBeat,
      finalPrice,
    };
  }

  return undefined;
}

/**
 * Вычисляет интервал свечи Binance из длительности окна.
 *
 * @param durationMs - Длительность окна в ms (endDateMs - eventStartTimeMs)
 * @returns Строка интервала для Binance API (e.g. '5m', '15m', '1h')
 *
 * @remarks
 * Маппинг основан на стандартных интервалах Binance klines API.
 * Если длительность не совпадает ни с одним интервалом — возвращает ближайший
 * больший или '1h' по умолчанию.
 *
 * @example
 * ```typescript
 * computeInterval(300_000);   // '5m'
 * computeInterval(900_000);   // '15m'
 * computeInterval(3_600_000); // '1h'
 * ```
 */
/**
 * Извлекает eventMetadata из events[0].
 *
 * @param rawMarket - Сырой объект рынка из Gamma API
 * @returns priceToBeat и finalPrice, или undefined если нет данных
 *
 * @remarks
 * Polymarket устанавливает эти поля в eventMetadata:
 * - `priceToBeat` — появляется после eventStartTime (strike price)
 * - `finalPrice` — появляется после endDate (resolution price)
 * Оба значения от Chainlink oracle.
 */
function _extractEventMetadata(rawMarket: Record<string, unknown>): { priceToBeat?: number; finalPrice?: number } | undefined {
  const events = rawMarket['events'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(events) || events.length === 0) return undefined;

  const meta = events[0]!['eventMetadata'] as Record<string, unknown> | undefined;
  if (!meta) return undefined;

  const toNum = (v: unknown): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  };

  return {
    priceToBeat: toNum(meta['priceToBeat']),
    finalPrice: toNum(meta['finalPrice']),
  };
}

export function computeInterval(durationMs: number): string {
  if (durationMs <= 60_000) return '1m';
  if (durationMs <= 180_000) return '3m';
  if (durationMs <= 300_000) return '5m';
  if (durationMs <= 900_000) return '15m';
  if (durationMs <= 1_800_000) return '30m';
  if (durationMs <= 3_600_000) return '1h';
  if (durationMs <= 7_200_000) return '2h';
  if (durationMs <= 14_400_000) return '4h';
  if (durationMs <= 28_800_000) return '8h';
  if (durationMs <= 43_200_000) return '12h';
  return '1d';
}

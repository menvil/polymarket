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
 * ### Settlement-фид ОТДЕЛЬНО от spot-фидов (MR-B)
 *
 * Для Up/Down-серий, чей `resolution.source` указывает на TWAP-стрим
 * Chainlink (`.../streams/btc-usd-twap-60s-streams`), официальный источник
 * расчёта — НЕ spot-цена, а отдельный RTDS-topic
 * `prices.crypto.chainlink.twap` с КОНКРЕТНЫМ окном усреднения. Такой рынок
 * получает ТРИ фида: Binance spot + Chainlink spot + Chainlink TWAP окна
 * рынка (spot-фиды сохраняются — TWAP дополняет данные, а не заменяет их).
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
import type {
  CryptoPricesChainlinkTwapTopic,
  CryptoPricesChainlinkTwapWindowSeconds,
  CryptoPricesTopic,
} from '@polymarket/bindings/subscriptions';
import type { Market } from '@polymarket/bindings/gamma';
import { asCryptoAssetId } from '@polymarket/ids';
import type { CryptoAssetId } from '@polymarket/ids';

/**
 * Spot-фид RTDS: vendor topic + символ в нативном формате.
 *
 * @remarks
 * Окна усреднения у spot-потоков нет — цена публикуется как есть.
 */
export interface PolymarketSpotRtdsFeed {
  /** Vendor topic RTDS SDK (`prices.crypto.binance` | `prices.crypto.chainlink`). */
  readonly topic: CryptoPricesTopic;
  /** Точный символ фида (Binance — `btcusdt`, Chainlink — `btc/usd`). */
  readonly symbol: string;
}

/**
 * Settlement-фид Chainlink TWAP: topic + символ + ОКНО усреднения.
 *
 * @remarks
 * Окно — часть identity фида, а не его атрибут: `btc/usd` TWAP 30s и
 * `btc/usd` TWAP 60s — РАЗНЫЕ потоки с разными значениями в один и тот же
 * момент (проверено live 2026-08-26). Подписка SDK принимает окно
 * отдельным полем spec-а (`{ topic, windowSeconds, symbols }`), и оно же
 * приходит обратно в `payload.windowSeconds` каждого события.
 */
export interface PolymarketTwapRtdsFeed {
  /** Vendor topic settlement-потока SDK. */
  readonly topic: CryptoPricesChainlinkTwapTopic;
  /** Точный символ фида (`btc/usd`). */
  readonly symbol: string;
  /** Окно усреднения TWAP в секундах (vendor-домен: строго 30 либо 60). */
  readonly windowSeconds: CryptoPricesChainlinkTwapWindowSeconds;
}

/**
 * Точный ключ одного RTDS-фида рынка.
 *
 * @remarks
 * Структурно совместим с `PolymarketRtdsFeedKey` recorder-а (N-002) —
 * координатор передаёт эти объекты в `registerMarket({ rtdsFeeds })`
 * без конверсии. Тип живёт здесь, потому что это словарь source-контура
 * (recorder зависит от polymarket-v2, обратная зависимость запрещена).
 *
 * Дискриминант — vendor `topic`: TWAP-вариант несёт обязательное
 * `windowSeconds`, spot-варианты его не имеют вовсе (непредставимо, а не
 * «optional и обычно undefined»).
 */
export type PolymarketRtdsFeed = PolymarketSpotRtdsFeed | PolymarketTwapRtdsFeed;

/**
 * Vendor topic settlement-потока Chainlink TWAP.
 *
 * @remarks
 * Константа, а не literal в пяти местах: тем же значением параметризуются
 * подписка Source, routing recorder-а и ref-count координатора.
 */
export const CHAINLINK_TWAP_TOPIC = 'prices.crypto.chainlink.twap' as const;

/**
 * Официальный settlement-дескриптор рынка (правило расчёта итога).
 *
 * @remarks
 * Разобранный ОДИН РАЗ на стадии discovery результат `resolution.source`:
 * downstream (координатор, recorder, finalizer) НЕ парсит URL повторно.
 * Сегодня поддержан ровно один вид — Chainlink TWAP; поле `kind` оставляет
 * место следующим, не заставляя потребителей знать про URL.
 */
export interface PolymarketChainlinkTwapSettlement {
  /** Вид settlement-правила. */
  readonly kind: 'chainlink-twap';
  /** Символ settlement-потока (`btc/usd`). */
  readonly symbol: string;
  /** Окно усреднения TWAP (строго из vendor-домена 30 | 60). */
  readonly windowSeconds: CryptoPricesChainlinkTwapWindowSeconds;
  /** Исходный `resolution.source` — provenance правила в архиве. */
  readonly resolutionSource: string;
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
  /**
   * Официальное правило расчёта итога, если оно распознано.
   *
   * @remarks
   * Присутствует ТОЛЬКО когда `resolution.source` — поддержанный TWAP-стрим
   * с точным окном. Отсутствие означает «settlement-правило неизвестно»:
   * деривация итога из записанных данных для такого рынка ЗАПРЕЩЕНА
   * (спот-цена — не источник расчёта).
   */
  readonly settlement?: PolymarketChainlinkTwapSettlement;
  /**
   * `resolution.source` рынка, чьё правило расчёта — TWAP, но локально НЕ
   * поддержано (окно вне vendor-домена либо незнакомая форма URL).
   *
   * @remarks
   * Взаимоисключающе с {@link PolymarketCryptoMeta.settlement}. Разделять
   * эти два случая обязательно, потому что политика у них ПРОТИВОПОЛОЖНАЯ:
   *
   * - обычный spot-рынок Chainlink (`…/btc-usd`) — правило расчёта нам не
   *   объявлено вовсе, и прежние приблизительные ступени по споту для него
   *   остаются допустимыми (verified-поведение до MR-B);
   * - рынок с TWAP-правилом, которое мы не умеем считать
   *   (`…/btc-usd-twap-45s-streams`) — источник расчёта ИЗВЕСТЕН и это НЕ
   *   спот. Вывести победителя по споту здесь означало бы присудить итог
   *   по потоку, которым рынок не рассчитывается. Такой рынок обязан быть
   *   отброшен, а не «посчитан приблизительно».
   *
   * Поле нужно ровно затем, чтобы расширение vendor-домена (TWAP 45/120 или
   * новая форма URL) РАНЬШЕ нашего кода не превратилось в молчаливую
   * подмену источника расчёта.
   */
  readonly unsupportedSettlementSource?: string;
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
 * Строгая форма TWAP-URL: `<base>-<quote>-twap-<N>s` c опциональным
 * `-streams`-суффиксом текущих серий.
 *
 * @remarks
 * Окно захватывается ГРУППОЙ, а не угадывается: любое `<N>` разбирается и
 * затем проверяется по vendor-домену. Эвристики «5m → 30s, 15m → 60s»
 * запрещены — длительность рынка и окно TWAP независимы (live 2026-08-26:
 * ВСЕ 5-минутные серии резолвятся 60-секундным TWAP).
 */
const CHAINLINK_TWAP_URL = /\/([a-z0-9]+)-([a-z0-9]+)-twap-(\d{1,4})s(?:-streams)?$/i;

/** Vendor-домен окон TWAP официального SDK (`CryptoPricesChainlinkTwapWindowSeconds`). */
const SUPPORTED_TWAP_WINDOWS: readonly number[] = [30, 60];

/**
 * Грубый признак «правило расчёта рынка — TWAP-стрим Chainlink».
 *
 * @remarks
 * Сознательно ШИРЕ строгого парсера: он ловит и те формы, которые парсер
 * разобрать НЕ смог (`-twap-45s`, `-twap-120s`, будущие расширения vendor).
 * Именно это различие критично — см.
 * {@link PolymarketCryptoMeta.unsupportedSettlementSource}.
 */
const CHAINLINK_TWAP_RULE = /-twap(?:-|$)/i;

/**
 * Указывает ли `resolution.source` на расчёт по TWAP-стриму Chainlink.
 *
 * @param resolutionSource - Значение `market.resolution.source`
 * @returns `true`, если рынок резолвится TWAP-потоком (независимо от того,
 *   поддержано ли его окно локально)
 *
 * @remarks
 * Отвечает на вопрос «каким ПРАВИЛОМ считается рынок», а не «умеем ли мы
 * его посчитать». Второе — задача {@link parseChainlinkTwapSettlement}.
 *
 * @example
 * ```typescript
 * isChainlinkTwapResolutionSource('…/btc-usd-twap-45s-streams'); // true (окно не поддержано)
 * isChainlinkTwapResolutionSource('…/btc-usd');                  // false (обычный spot)
 * ```
 */
export function isChainlinkTwapResolutionSource(
  resolutionSource: string | null | undefined,
): boolean {
  return (
    resolutionSource !== null &&
    resolutionSource !== undefined &&
    resolutionSource.includes('chain.link') &&
    CHAINLINK_TWAP_RULE.test(resolutionSource)
  );
}

/**
 * Разбирает `resolution.source` в официальный settlement-дескриптор.
 *
 * @param resolutionSource - Значение `market.resolution.source` (URL правила)
 * @returns Дескриптор с точным символом и окном либо `undefined`, если URL
 *   не является поддержанным TWAP-стримом
 *
 * @remarks
 * СТРОГИЙ парсер (MR-B PART 11): неизвестное окно (`twap-45s`) НЕ
 * подменяется ближайшим поддержанным — возвращается `undefined`, то есть
 * «settlement-правило неизвестно». Молчаливая подстановка 30/60 дала бы
 * рынок, чей архив резолвится не тем потоком, которым он реально
 * рассчитывается, — худший из возможных исходов для датасета.
 *
 * @example
 * ```typescript
 * parseChainlinkTwapSettlement('https://data.chain.link/streams/btc-usd-twap-60s-streams');
 * // → { kind: 'chainlink-twap', symbol: 'btc/usd', windowSeconds: 60, resolutionSource: '…' }
 *
 * parseChainlinkTwapSettlement('https://data.chain.link/streams/btc-usd-twap-45s-streams');
 * // → undefined (окно вне vendor-домена)
 * ```
 */
export function parseChainlinkTwapSettlement(
  resolutionSource: string | null | undefined,
): PolymarketChainlinkTwapSettlement | undefined {
  if (
    resolutionSource === null ||
    resolutionSource === undefined ||
    !resolutionSource.includes('chain.link')
  ) {
    return undefined;
  }
  const match = CHAINLINK_TWAP_URL.exec(resolutionSource);
  if (match === null) {
    return undefined;
  }
  const windowSeconds = Number(match[3]);
  if (!SUPPORTED_TWAP_WINDOWS.includes(windowSeconds)) {
    return undefined; // окно вне vendor-домена — правило не поддержано
  }
  return {
    kind: 'chainlink-twap',
    symbol: `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`,
    // Сужение безопасно: значение только что проверено по vendor-домену
    windowSeconds: windowSeconds as CryptoPricesChainlinkTwapWindowSeconds,
    resolutionSource,
  };
}

/**
 * Отличает settlement-фид TWAP от spot-фидов (type guard union-а).
 *
 * @param feed - Любой RTDS-фид рынка
 * @returns `true`, если фид — Chainlink TWAP с окном
 *
 * @example
 * ```typescript
 * const twap = selected.rtdsFeeds.find(isTwapRtdsFeed);
 * if (twap) console.log(twap.windowSeconds); // 30 | 60, сужено компилятором
 * ```
 */
export function isTwapRtdsFeed(feed: PolymarketRtdsFeed): feed is PolymarketTwapRtdsFeed {
  return feed.topic === CHAINLINK_TWAP_TOPIC;
}

/**
 * Строит ТОЧНЫЙ ключ идентичности RTDS-фида.
 *
 * @param feed - Фид рынка
 * @returns Строковый ключ, различающий topic, символ и (для TWAP) окно
 *
 * @remarks
 * ЕДИНСТВЕННОЕ правило идентичности фида на весь контур: по нему
 * координатор ведёт ref-count source-подписок, а recorder — routing записи.
 * `btc/usd` TWAP 30 и `btc/usd` TWAP 60 обязаны давать РАЗНЫЕ ключи —
 * иначе один рынок получал бы наблюдения чужого окна. Разделитель `\n` не
 * встречается в vendor-символах, поэтому склейка неоднозначной быть не может.
 *
 * @example
 * ```typescript
 * rtdsFeedKey({ topic: 'prices.crypto.chainlink', symbol: 'btc/usd' });
 * // → 'prices.crypto.chainlink\nbtc/usd'
 * rtdsFeedKey({ topic: 'prices.crypto.chainlink.twap', symbol: 'btc/usd', windowSeconds: 60 });
 * // → 'prices.crypto.chainlink.twap\nbtc/usd\n60'
 * ```
 */
export function rtdsFeedKey(feed: PolymarketRtdsFeed): string {
  return isTwapRtdsFeed(feed)
    ? `${feed.topic}\n${feed.symbol}\n${String(feed.windowSeconds)}`
    : `${feed.topic}\n${feed.symbol}`;
}

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
    // Settlement-фид ДОПОЛНЯЕТ spot-фиды (MR-B PART 15): порядок существующих
    // фидов не меняется, TWAP добавляется последним — только для рынков, чей
    // resolution.source разобрался в поддержанное окно.
    const settlement = parseChainlinkTwapSettlement(resolutionSource);
    // Правило TWAP есть, но разобрать его мы не смогли — рынок продолжает
    // собираться по spot-фидам, но НИКАКАЯ деривация итога для него не
    // разрешена (см. `unsupportedSettlementSource`)
    const unsupportedSettlement =
      settlement === undefined && isChainlinkTwapResolutionSource(resolutionSource);
    return {
      source: 'chainlink',
      asset,
      binanceSymbol,
      feeds: [
        { topic: 'prices.crypto.chainlink', symbol: chainlinkSymbol },
        { topic: 'prices.crypto.binance', symbol: binanceSymbol.toLowerCase() },
        ...(settlement !== undefined
          ? [
              {
                topic: CHAINLINK_TWAP_TOPIC,
                symbol: settlement.symbol,
                windowSeconds: settlement.windowSeconds,
              } satisfies PolymarketTwapRtdsFeed,
            ]
          : []),
      ],
      ...(settlement !== undefined ? { settlement } : {}),
      ...(unsupportedSettlement ? { unsupportedSettlementSource: resolutionSource } : {}),
    };
  }

  return undefined;
}

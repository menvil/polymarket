/**
 * Сборка канонического доменного `Market` из метаданных рынка, доступных боту.
 *
 * @remarks
 * ### Проблема
 * `StrategyScheduler.register()` принимает каноническую сущность `Market`
 * (`@polymarket/market`). Ротация рынков и бэктест-раннеры исторически не имели
 * её под рукой и подсовывали заглушку:
 *
 * ```typescript
 * const marketStub = { expiresAt } as Parameters<typeof register>[0]['market'];
 * ```
 *
 * Такая заглушка компилируется (каст стирает проверку), но в рантайме у неё нет
 * ни `outcomes`, ни `id`, ни `question`. Любая стратегия, которая читает
 * `snapshot.market.outcomes`, получает `undefined` и молча уходит в свою ветку
 * fallback — ровно так `BinanceProbMMStrategy` считала DOWN-токен UP-токеном.
 *
 * ### Решение
 * Один общий конструктор, который собирает **настоящий** `Market` из тех данных,
 * что уже есть на каждой площадке вызова (discovery-кандидат, snapshot meta,
 * Gamma rawMarket). Все инварианты проверяет `Market.create()`; функция ничего
 * не выдумывает: если честно собрать рынок нельзя — возвращает `Err`.
 *
 * ### Два семейства, а не одно
 * Крипто-метаданные есть не у каждого рынка: `parseCryptoMeta()` возвращает
 * `undefined`, когда `rawMarket` отсутствует (`DataRecorder` пишет его условно)
 * либо `resolutionSource` не указывает на Binance/Chainlink. Такой рынок
 * существует, торгуется и реплеится — поэтому он собирается как
 * `BINARY_OUTCOME` (два исхода и расписание, без предметной спецификации),
 * а не отбраковывается. `CRYPTO_UP_DOWN` строится только тогда, когда
 * крипто-метаданные реально пришли.
 *
 * ### Чего функция НЕ делает
 * Не изобретает второй `instrumentId`, не угадывает крипто-актив и не «чинит»
 * противоречивое расписание. Каждый такой случай — `Err` с полем `field`
 * в контексте ошибки, чтобы вызывающий залогировал причину и отменил
 * регистрацию, а не торговал на выдуманных данных.
 */

import type { MarketId, InstrumentId } from '@polymarket/ids';
import { normalizeCryptoAsset } from '@polymarket/strategy';
import {
  Market,
  MarketState,
  MarketValidationError,
  KnownVenues,
  asMarketDuration,
} from '@polymarket/market';
import type { MarketOutcome, OutcomeIndex, CryptoUpDownSpec } from '@polymarket/market';
import { Result, Ok, Err } from '@polymarket/result';
import { TimestampService } from '@polymarket/timestamp';

/**
 * Метки исходов по позиции: индекс 0 — Up, индекс 1 — Down.
 *
 * @remarks
 * Конвенция `outcomeIndex 0 = up / 1 = down` уже действует в репозитории
 * (`MarketRotation.openMarket`, `readSnapshotMeta`, `BacktestEngine`).
 * Именно эти строки распознают `isUpLikeOutcome`/`isDownLikeOutcome`
 * в `BinanceProbMMStrategy`, поэтому метки задаются здесь дословно.
 */
const OUTCOME_LABELS = ['Up', 'Down'] as const;

/**
 * Длительность рынка по умолчанию, когда начало расписания неизвестно — 1 час.
 *
 * @remarks
 * Значение выбрано не произвольно: часовая серия («Bitcoin Up or Down — 6PM ET»)
 * — доминирующее семейство крипто-рынков Polymarket, на котором работает бот.
 *
 * Fallback включается ТОЛЬКО когда неизвестны оба источника начала расписания
 * (`startsAtMs` и `eventStartMs`) и влияет ровно на одно поле — `startsAt`.
 * Номинальную `crypto.duration` он НЕ задаёт: она считается по окну крипто-серии
 * и от расписания рынка не зависит (см. {@link buildCanonicalMarket}).
 * Торговый контур `startsAt` не читает — стратегии берут `market.expiresAt`
 * и отдельное поле снапшота `eventStartMs` (оно приходит в `scheduler.register()`
 * из того же источника и остаётся `undefined`, если начала мы не знаем).
 * Fallback нужен исключительно для строгого инварианта `startsAt < expiresAt`,
 * без которого `Market.create()` не пропустит рынок.
 */
export const FALLBACK_MARKET_DURATION_MS = 60 * 60 * 1000;

/**
 * Метаданные крипто-серии, к которой принадлежит рынок.
 *
 * @remarks
 * Наличие этого блока и есть признак семейства: он есть → `CRYPTO_UP_DOWN`,
 * его нет → `BINARY_OUTCOME`. Все три поля берутся из одного источника —
 * `CryptoMarketMeta` (`parseCryptoMeta()`), поэтому они либо приходят вместе,
 * либо не приходят вовсе.
 */
export interface CanonicalMarketCryptoInput {
  /**
   * Сырой символ крипто-серии — ровно та строка, что уходит в
   * `scheduler.register({ cryptoSymbol })` (обычно `cryptoMeta.rtdsFilter`:
   * `btc/usd` или `btcusdt`).
   *
   * @remarks
   * Передаётся сырым, а не готовым `CryptoAssetId`: нормализация выполняется
   * функцией `normalizeCryptoAsset`, экспортированной из `@polymarket/strategy`
   * — той же самой, которой планировщик выводит `StrategyEntry.cryptoAsset`.
   * Так `market.crypto.asset` и актив планировщика не могут разойтись.
   */
  readonly symbol: string;
  /** Начало окна СЕРИИ (`cryptoMeta.eventStartTimeMs`), epoch ms */
  readonly eventStartMs: number;
  /** Конец окна СЕРИИ (`cryptoMeta.endDateMs`), epoch ms */
  readonly eventEndMs: number;
}

/**
 * Входные данные для сборки канонического `Market`.
 *
 * @remarks
 * Набор полей намеренно совпадает с тем, что уже есть в каждой точке вызова:
 * ротация берёт их из `MarketSlot`, бэктесты — из `readSnapshotMeta` и
 * Gamma `rawMarket`.
 *
 * Начало расписания рынка и начало события — **разные** поля, и здесь они
 * разделены так же, как в `DiscoveredMarket` и `StrategySnapshot`.
 */
export interface CanonicalMarketInput {
  /** ID рынка (conditionId) */
  readonly marketId: MarketId;
  /** Вопрос рынка из Gamma; `undefined` — если площадка его не отдала */
  readonly question: string | undefined;
  /** Инструмент торгуемого исхода */
  readonly instrumentId: InstrumentId;
  /** Инструмент противоположного исхода того же рынка */
  readonly complementaryInstrumentId: InstrumentId | undefined;
  /** Позиция торгуемого исхода: 0 = Up, 1 = Down */
  readonly outcomeIndex: OutcomeIndex;
  /** Плановое окончание торгов (epoch ms) */
  readonly expiresAtMs: number;
  /**
   * Начало расписания САМОГО РЫНКА (epoch ms) — `DiscoveredMarket.startsAt`,
   * то есть `events[0].startDate` у Gamma. Основной источник `Market.startsAt`.
   */
  readonly startsAtMs: number | undefined;
  /**
   * Начало СОБЫТИЯ (epoch ms) — Gamma `eventStartTime`. Запасной источник
   * `Market.startsAt`: это начало события, к которому привязан рынок, а не
   * расписание самого рынка.
   */
  readonly eventStartMs: number | undefined;
  /** Метаданные crypto-серии; отсутствуют → семейство `BINARY_OUTCOME` */
  readonly crypto: CanonicalMarketCryptoInput | undefined;
}

/**
 * Семейство рынка вместе с его спецификацией — ровно те два поля `MarketProps`,
 * связка которых проверяется в `Market.create()`.
 *
 * @remarks
 * Union, а не два независимых поля: у `BINARY_OUTCOME` ключа `crypto` нет
 * вообще, и это выражено типом, а не соглашением. `Market.create()` запрещает
 * нести crypto-спецификацию любому семейству, кроме `CRYPTO_UP_DOWN`.
 */
type MarketFamilyProps =
  | { readonly family: 'BINARY_OUTCOME' }
  | { readonly family: 'CRYPTO_UP_DOWN'; readonly crypto: CryptoUpDownSpec };

/**
 * Выбирает начало расписания рынка по цепочке источников.
 *
 * Приоритет:
 * 1. `startsAtMs` — начало расписания САМОГО рынка. `Market.startsAt` по
 *    определению именно оно, поэтому оно и первое.
 * 2. `eventStartMs` — начало события, к которому привязан рынок. Площадка
 *    открывает рынок вместе с его событием, расхождение — секунды публикации,
 *    поэтому как приближение это честно; выдумкой было бы взять его при
 *    известном собственном начале рынка, чего шаг 1 и не даёт сделать.
 * 3. `expiresAtMs - FALLBACK_MARKET_DURATION_MS` — оба источника молчат.
 *    Обоснование значения — в TSDoc {@link FALLBACK_MARKET_DURATION_MS}.
 *
 * @param input - Метаданные рынка
 * @returns `Result` с началом расписания (epoch ms) либо `MarketValidationError`
 * @throws Ничего не бросает — все нарушения возвращаются как `Err`
 *
 * @remarks
 * Выбранный источник, который оказался НЕ раньше `expiresAtMs`, — это
 * противоречие в данных площадки, а не пробел в них. Переход к следующему
 * источнику «починил» бы расписание, которого не существует, поэтому здесь
 * `Err`, а не молчаливый сдвиг.
 *
 * @example
 * ```typescript
 * const startsAt = _resolveStartsAtMs({ ...input, startsAtMs: undefined });
 * if (startsAt.ok) console.log(new Date(startsAt.value).toISOString());
 * ```
 */
function _resolveStartsAtMs(input: CanonicalMarketInput): Result<number, MarketValidationError> {
  const marketStart = _finiteOrUndefined(input.startsAtMs);
  const eventStart = _finiteOrUndefined(input.eventStartMs);
  const source = marketStart !== undefined
    ? ({ field: 'startsAt', value: marketStart } as const)
    : eventStart !== undefined
      ? ({ field: 'eventStartMs', value: eventStart } as const)
      : undefined;

  if (source === undefined) {
    return Ok(input.expiresAtMs - FALLBACK_MARKET_DURATION_MS);
  }

  if (source.value >= input.expiresAtMs) {
    return Err(
      new MarketValidationError('Market schedule start must be strictly before expiration', {
        context: {
          field: 'startsAt',
          source: source.field,
          marketId: String(input.marketId),
          startsAtMs: source.value,
          expiresAtMs: input.expiresAtMs,
        },
      }),
    );
  }

  return Ok(source.value);
}

/**
 * Определяет семейство рынка и его спецификацию по наличию крипто-метаданных.
 *
 * Алгоритм:
 * 1. Крипто-метаданных нет → `BINARY_OUTCOME` без спецификации.
 * 2. Есть → нормализуем символ тем же `normalizeCryptoAsset`, что и планировщик.
 * 3. Считаем номинальную длительность серии по окну события: `eventEndMs - eventStartMs`.
 *
 * @param input - Метаданные рынка
 * @returns `Result` с парой «семейство + спецификация» либо `MarketValidationError`
 * @throws Ничего не бросает — все нарушения возвращаются как `Err`
 *
 * @remarks
 * Длительность берётся из окна СЕРИИ, а не из расписания рынка
 * (`expiresAt - startsAt`). `MarketDuration` — это номинал серии (5 минут, час),
 * то есть классификация рынка, и он намеренно не обязан совпадать с наблюдаемым
 * окном: площадка сдвигает границы конкретного рынка внутри серии. Вывод
 * номинала из расписания схлопнул бы ровно то различие, ради которого тип
 * и существует.
 *
 * Отсутствующие крипто-метаданные — это пробел (семейство `BINARY_OUTCOME`),
 * а вот присутствующие, но противоречивые (символ не нормализуется, окно серии
 * не положительное) — ошибка: рынок объявлен крипто-серийным, но спецификацию
 * из него честно не собрать.
 */
function _resolveFamily(input: CanonicalMarketInput): Result<MarketFamilyProps, MarketValidationError> {
  const crypto = input.crypto;
  if (crypto === undefined) {
    return Ok({ family: 'BINARY_OUTCOME' });
  }

  const asset = normalizeCryptoAsset(crypto.symbol);
  if (asset === undefined) {
    return Err(
      new MarketValidationError('Cannot build canonical market with unknown crypto asset', {
        context: {
          field: 'crypto.asset',
          marketId: String(input.marketId),
          cryptoSymbol: crypto.symbol,
        },
      }),
    );
  }

  const seriesWindowMs = crypto.eventEndMs - crypto.eventStartMs;
  const duration = asMarketDuration(seriesWindowMs);
  if (duration === undefined) {
    return Err(
      new MarketValidationError('Cannot build canonical market with invalid crypto series duration', {
        context: {
          field: 'crypto.duration',
          marketId: String(input.marketId),
          eventStartMs: crypto.eventStartMs,
          eventEndMs: crypto.eventEndMs,
          durationMs: seriesWindowMs,
        },
      }),
    );
  }

  return Ok({ family: 'CRYPTO_UP_DOWN', crypto: { asset, duration } });
}

/**
 * Возвращает число, если оно задано и конечно.
 *
 * @param value - Кандидат (epoch ms из внешних данных)
 * @returns То же число либо `undefined` для `undefined`/`NaN`/`Infinity`
 *
 * @example
 * ```typescript
 * _finiteOrUndefined(NaN); // → undefined
 * ```
 */
function _finiteOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

/**
 * Собирает канонический `Market` из метаданных бота.
 *
 * Алгоритм:
 * 1. Проверяем наличие комплементарного инструмента — без него двух исходов нет.
 * 2. Проверяем `expiresAt` и выбираем `startsAt` по цепочке
 *    `startsAtMs` → `eventStartMs` → `expiresAtMs - FALLBACK_MARKET_DURATION_MS`
 *    (см. {@link _resolveStartsAtMs}).
 * 3. Определяем семейство: крипто-метаданные есть → `CRYPTO_UP_DOWN`
 *    со спецификацией, нет → `BINARY_OUTCOME` (см. {@link _resolveFamily}).
 * 4. Раскладываем исходы по позициям: торгуемый — на `outcomeIndex`,
 *    комплементарный — на противоположную.
 * 5. Отдаём всё в `Market.create()`, который проверяет доменные инварианты.
 *
 * @param input - Метаданные рынка, доступные в точке регистрации стратегии
 * @returns `Result` с каноническим `Market` либо `MarketValidationError` с полем
 *          `context.field`, указывающим, какого честного данного не хватило
 * @throws Ничего не бросает — все нарушения возвращаются как `Err`
 *
 * @remarks
 * ### Почему каждое решение именно такое
 *
 * - **`question` пуст или отсутствует → `String(marketId)`.** Вопрос —
 *   человекочитаемая подпись, она не участвует в торговых решениях, но
 *   `Market.create()` требует непустую строку. Идентификатор рынка —
 *   единственная подстановка, которая ничего не выдумывает и остаётся
 *   однозначной в логах. Тот же fallback уже действует
 *   в `MarketRotation.registerMarketAndStrategy` при записи рынка в recording.
 * - **`complementaryInstrumentId` отсутствует → `Err`.** Второй исход нельзя
 *   ни вывести, ни угадать: CTF-токены комплементарной пары не выводятся из
 *   одного лишь торгуемого `tokenId` без `conditionId` в hex-форме, а придуманный
 *   `instrumentId` привёл бы к маршрутизации ордеров в несуществующий инструмент.
 * - **Крипто-метаданных нет → `BINARY_OUTCOME`.** Это не «неизвестное
 *   семейство», а точное утверждение о рынке: два исхода и окно торгов.
 *   Отбраковка таких рынков сделала бы нереплеиваемыми снапшоты без `rawMarket`
 *   и все не-крипто рынки.
 * - **Крипто-метаданные есть, но противоречивы → `Err`.** Символ, который не
 *   нормализуется, и неположительное окно серии — это заявка на `CRYPTO_UP_DOWN`
 *   без спецификации; «btc по умолчанию» соврал бы о том, на чём строится
 *   модель цены.
 * - **Начало расписания → цепочка приоритетов, противоречие → `Err`.**
 *   Обоснование — в TSDoc {@link _resolveStartsAtMs}.
 * - **`state` → `MarketState.active()`.** Регистрация стратегии происходит
 *   только на рынке, который площадка отдаёт как торгуемый; подтверждённого
 *   закрытия/резолюции в этот момент у нас нет.
 * - **`slug` не заполняется.** Домен его не требует, а строить слаг из вопроса
 *   значило бы выдумывать идентификатор площадки.
 *
 * @example
 * ```typescript
 * const marketResult = buildCanonicalMarket({
 *   marketId: slot.marketId,
 *   question: slot.candidate?.question,
 *   instrumentId: slot.instrumentId,
 *   complementaryInstrumentId: slot.complementaryInstrumentId,
 *   outcomeIndex: slot.outcomeIndex,
 *   expiresAtMs: slot.expiresAtMs,
 *   startsAtMs: slot.candidate?.startsAt?.toNumber(),
 *   eventStartMs: slot.cryptoMeta?.eventStartTimeMs,
 *   crypto: slot.cryptoMeta
 *     ? {
 *         symbol: slot.cryptoMeta.rtdsFilter,
 *         eventStartMs: slot.cryptoMeta.eventStartTimeMs,
 *         eventEndMs: slot.cryptoMeta.endDateMs,
 *       }
 *     : undefined,
 * });
 * if (!marketResult.ok) {
 *   logger.error('Failed to build canonical market', { error: marketResult.error.message });
 *   return false;
 * }
 * await engine.scheduler.register({ ...rest, market: marketResult.value });
 * ```
 */
export function buildCanonicalMarket(
  input: CanonicalMarketInput,
): Result<Market, MarketValidationError> {
  const { marketId, instrumentId, complementaryInstrumentId, outcomeIndex } = input;

  // 1. Второй исход обязателен: рынок без него — не рынок, а половина рынка.
  if (complementaryInstrumentId === undefined) {
    return Err(
      new MarketValidationError(
        'Cannot build canonical market without complementary instrument id',
        { context: { field: 'complementaryInstrumentId', marketId: String(marketId) } },
      ),
    );
  }

  // 2. Расписание.
  const expiresAtResult = TimestampService.create(input.expiresAtMs);
  if (!expiresAtResult.ok) {
    return Err(
      new MarketValidationError('Cannot build canonical market with invalid expiresAt', {
        context: {
          field: 'expiresAt',
          marketId: String(marketId),
          expiresAtMs: input.expiresAtMs,
        },
      }),
    );
  }

  const startsAtMsResult = _resolveStartsAtMs(input);
  if (!startsAtMsResult.ok) return Err(startsAtMsResult.error);

  const startsAtResult = TimestampService.create(startsAtMsResult.value);
  if (!startsAtResult.ok) {
    return Err(
      new MarketValidationError('Cannot build canonical market with invalid startsAt', {
        context: {
          field: 'startsAt',
          marketId: String(marketId),
          startsAtMs: startsAtMsResult.value,
        },
      }),
    );
  }

  // 3. Семейство и его спецификация.
  const familyResult = _resolveFamily(input);
  if (!familyResult.ok) return Err(familyResult.error);

  // 4. Исходы: торгуемый — на своей позиции, комплементарный — на встречной.
  const complementaryIndex: OutcomeIndex = outcomeIndex === 0 ? 1 : 0;
  const tradedOutcome: MarketOutcome = {
    index: outcomeIndex,
    label: OUTCOME_LABELS[outcomeIndex],
    instrumentId,
  };
  const complementaryOutcome: MarketOutcome = {
    index: complementaryIndex,
    label: OUTCOME_LABELS[complementaryIndex],
    instrumentId: complementaryInstrumentId,
  };
  const outcomes: readonly [MarketOutcome, MarketOutcome] =
    outcomeIndex === 0
      ? [tradedOutcome, complementaryOutcome]
      : [complementaryOutcome, tradedOutcome];

  // 5. Доменные инварианты проверяет сама сущность. Семейство и спецификация
  //    раскрываются одним spread: у BINARY_OUTCOME ключа `crypto` нет вовсе,
  //    а не `crypto: undefined`.
  return Market.create({
    id: marketId,
    venueId: KnownVenues.POLYMARKET,
    question: input.question?.trim() ? input.question : String(marketId),
    startsAt: startsAtResult.value,
    expiresAt: expiresAtResult.value,
    state: MarketState.active(),
    outcomes,
    ...familyResult.value,
  });
}

/**
 * Достаёт начало расписания рынка из Gamma `rawMarket` (`events[0].startDate`).
 *
 * @param rawMarket - Сырой объект рынка из Gamma API (поле `m` meta-строки снапшота)
 * @returns Начало расписания в epoch ms либо `undefined`, если поля нет или оно
 *          не разбирается в дату
 * @throws Ничего не бросает — непригодные данные дают `undefined`
 *
 * @remarks
 * Бэктест-раннеры получают рынок не от discovery, а из meta-строки снапшота,
 * где `DiscoveredMarket.startsAt` уже не сохранён — но исходный `rawMarket`
 * записан целиком, и `events[0].startDate` в нём тот же самый, из которого
 * discovery строит `startsAt`. Хелпер живёт рядом с конструктором, потому что
 * обе бэктест-точки вызова читают это поле для одного и того же входа
 * {@link CanonicalMarketInput.startsAtMs}.
 *
 * `undefined` здесь — штатный случай: цепочка приоритетов
 * {@link buildCanonicalMarket} перейдёт к следующему источнику.
 *
 * @example
 * ```typescript
 * const startsAtMs = parseGammaMarketStartMs(rawMarket); // → 1756713600000 | undefined
 * ```
 */
export function parseGammaMarketStartMs(
  rawMarket: Record<string, unknown> | undefined,
): number | undefined {
  const events = rawMarket?.['events'];
  if (!Array.isArray(events) || events.length === 0) return undefined;

  const first = events[0] as Record<string, unknown> | undefined;
  const startDate = first?.['startDate'];
  if (typeof startDate !== 'string') return undefined;

  const startMs = new Date(startDate).getTime();
  return Number.isFinite(startMs) ? startMs : undefined;
}

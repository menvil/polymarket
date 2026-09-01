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
import type { MarketOutcome, OutcomeIndex } from '@polymarket/market';
import { Result, Err } from '@polymarket/result';
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
 * Длительность рынка по умолчанию, когда точное начало события неизвестно — 1 час.
 *
 * @remarks
 * Значение выбрано не произвольно: часовая серия («Bitcoin Up or Down — 6PM ET»)
 * — доминирующее семейство крипто-рынков Polymarket, на котором работает бот.
 *
 * Fallback включается ТОЛЬКО когда Gamma не отдала `eventStartTime`. Он влияет
 * на два поля: `startsAt` и производную `crypto.duration`. Ни то, ни другое не
 * читается торговым контуром — стратегии берут `market.expiresAt` и отдельное
 * поле снапшота `eventStartMs` (оно приходит в `scheduler.register()` из того же
 * источника и остаётся `undefined`, если начала мы не знаем). Fallback нужен
 * исключительно для строгого инварианта `startsAt < expiresAt`, без которого
 * `Market.create()` не пропустит рынок.
 */
export const FALLBACK_MARKET_DURATION_MS = 60 * 60 * 1000;

/**
 * Входные данные для сборки канонического `Market`.
 *
 * @remarks
 * Набор полей намеренно совпадает с тем, что уже есть в каждой точке вызова:
 * ротация берёт их из `MarketSlot`, бэктесты — из `readSnapshotMeta` и
 * Gamma `rawMarket`.
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
  /** Точное начало события (epoch ms), если Gamma его отдала */
  readonly eventStartMs: number | undefined;
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
  readonly cryptoSymbol: string | undefined;
}

/**
 * Собирает канонический `Market` семейства `CRYPTO_UP_DOWN` из метаданных бота.
 *
 * Алгоритм:
 * 1. Проверяем наличие комплементарного инструмента — без него двух исходов нет.
 * 2. Нормализуем крипто-символ в `CryptoAssetId`.
 * 3. Считаем расписание: `expiresAt` обязателен, `startsAt` = точное начало
 *    события либо `expiresAt - FALLBACK_MARKET_DURATION_MS`.
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
 * ### Почему каждый fallback именно такой
 *
 * - **`question` пуст или отсутствует → `String(marketId)`.** Вопрос —
 *   человекочитаемая подпись, она не участвует в торговых решениях, но
 *   `Market.create()` требует непустую строку. Идентификатор рынка — единственная подстановка, которая ничего не
 *   выдумывает и остаётся однозначной в логах. Тот же fallback уже действует
 *   в `MarketRotation.registerMarketAndStrategy` при записи рынка в recording.
 * - **`complementaryInstrumentId` отсутствует → `Err`.** Второй исход нельзя
 *   ни вывести, ни угадать: CTF-токены комплементарной пары не выводятся из
 *   одного лишь торгуемого `tokenId` без `conditionId` в hex-форме, а придуманный
 *   `instrumentId` привёл бы к маршрутизации ордеров в несуществующий инструмент.
 * - **`eventStartMs` неизвестен → `expiresAtMs - FALLBACK_MARKET_DURATION_MS`.**
 *   Обоснование значения — в TSDoc {@link FALLBACK_MARKET_DURATION_MS}.
 * - **`eventStartMs` известен, но `>= expiresAtMs` → `Err`.** Это противоречие
 *   в данных площадки, а не пробел в них. «Починить» его сдвигом означало бы
 *   торговать на расписании, которого не существует.
 * - **Крипто-актив неизвестен → `Err`.** `family: 'CRYPTO_UP_DOWN'` обязывает
 *   указать актив; подставить «btc по умолчанию» значит соврать о том, на чём
 *   строится модель цены.
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
 *   eventStartMs: slot.cryptoMeta?.eventStartTimeMs,
 *   cryptoSymbol: slot.cryptoMeta?.rtdsFilter,
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

  // 2. Крипто-актив: тем же нормализатором, что и планировщик, — своя копия
  //    алгоритма разошлась бы с ним молча.
  const cryptoAsset = normalizeCryptoAsset(input.cryptoSymbol);
  if (cryptoAsset === undefined) {
    return Err(
      new MarketValidationError('Cannot build canonical market with unknown crypto asset', {
        context: {
          field: 'crypto.asset',
          marketId: String(marketId),
          cryptoSymbol: input.cryptoSymbol,
        },
      }),
    );
  }

  // 3. Расписание.
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

  const eventStartMs = input.eventStartMs !== undefined && Number.isFinite(input.eventStartMs)
    ? input.eventStartMs
    : undefined;
  if (eventStartMs !== undefined && eventStartMs >= input.expiresAtMs) {
    return Err(
      new MarketValidationError('Market event start must be strictly before expiration', {
        context: {
          field: 'startsAt',
          marketId: String(marketId),
          eventStartMs,
          expiresAtMs: input.expiresAtMs,
        },
      }),
    );
  }

  const startsAtMs = eventStartMs ?? input.expiresAtMs - FALLBACK_MARKET_DURATION_MS;
  const startsAtResult = TimestampService.create(startsAtMs);
  if (!startsAtResult.ok) {
    return Err(
      new MarketValidationError('Cannot build canonical market with invalid startsAt', {
        context: { field: 'startsAt', marketId: String(marketId), startsAtMs },
      }),
    );
  }

  const duration = asMarketDuration(input.expiresAtMs - startsAtMs);
  if (duration === undefined) {
    return Err(
      new MarketValidationError('Cannot build canonical market with invalid duration', {
        context: {
          field: 'crypto.duration',
          marketId: String(marketId),
          durationMs: input.expiresAtMs - startsAtMs,
        },
      }),
    );
  }

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

  // 5. Доменные инварианты проверяет сама сущность.
  return Market.create({
    id: marketId,
    venueId: KnownVenues.POLYMARKET,
    question: input.question?.trim() ? input.question : String(marketId),
    startsAt: startsAtResult.value,
    expiresAt: expiresAtResult.value,
    state: MarketState.active(),
    outcomes,
    family: 'CRYPTO_UP_DOWN',
    crypto: { asset: cryptoAsset, duration },
  });
}

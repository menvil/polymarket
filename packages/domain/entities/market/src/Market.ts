/**
 * Market — каноническое доменное представление наблюдаемого внешнего рынка
 *
 * @remarks
 * `Market` — это **то, что мы наблюдаем у площадки**, а не объект, которым наша
 * программа административно управляет. Мы не открываем и не закрываем внешний
 * рынок; мы фиксируем его подтверждённое состояние и структуру.
 *
 * Market — граница между инфраструктурой и приложением:
 *
 * ```text
 * Polymarket V2 client/bindings
 *   ↓
 * Infrastructure mapping
 *   ↓
 * Domain Market          ← этот файл
 *   ↓
 * Application
 * ```
 *
 * Ниже этой границы живут vendor-типы (V2 `@polymarket/client` / `@polymarket/bindings`,
 * Gamma DTO, RTDS-сообщения). Выше — только canonical VO. Domain Market не зависит
 * ни от V2, ни от legacy V1 и не содержит vendor-payload'ов.
 *
 * ### Что входит в Market: identity и структура
 * ```text
 * id, venueId, slug?, question
 * startsAt, expiresAt        — расписание рынка
 * state                      — подтверждённое внешнее состояние
 * outcomes                   — ровно два исхода с canonical InstrumentId
 * family (+ спецификация)    — как устроен рынок и о чём он
 * ```
 *
 * ### Что в Market НЕ входит
 * ```text
 * liquidity, spread, orderbook, last trade, current price, reference price,
 * RTDS-подписки, Gamma Market/Event, SDK-объекты, Record<string, unknown> payloads
 * ```
 * Причина: это быстро меняющиеся **наблюдаемые метрики и состояние рынка**, а не
 * его identity/структура. Хранить их в entity значит либо пересоздавать Market
 * на каждый тик стакана, либо держать в нём устаревшие значения. Стакан живёт
 * в `@polymarket/orderbook`, лента — в `@polymarket/trade-tape`, топ книги —
 * в `StrategySnapshot.topOfBook`.
 *
 * ### Иммутабельность и часы
 * Все поля readonly, переходы возвращают новый экземпляр. Внутри Market нет
 * ни одного обращения к `Date.now()`: «сейчас» всегда приходит параметром как
 * {@link Timestamp}. Благодаря этому live и backtest используют одну и ту же
 * entity, а разницу задаёт инжектированный `IClock` снаружи.
 *
 * ### Жизненный цикл
 * ```text
 * ACTIVE → CLOSED        ACTIVE → RESOLVED        CLOSED → RESOLVED
 * ```
 * `ACTIVE → RESOLVED` разрешён: между опросами источника рынок мог успеть и
 * закрыться, и разрезолвиться. Повторное наблюдение того же состояния
 * идемпотентно; отклоняются только регрессия `RESOLVED → CLOSED` и конфликт
 * `RESOLVED(i) → RESOLVED(j≠i)`. Подробности — в TSDoc `MarketState`.
 *
 * Истечение `expiresAt` **не** переводит рынок в CLOSED: площадка может продолжать
 * публиковать его как ACTIVE ещё какое-то время. Производную фазу
 * (`PRE_OPEN`/`OPEN`/`ENDED`/`CLOSED`/`RESOLVED`) вычисляет
 * `MarketTradingPolicy.getPhase()`; в Market она не хранится.
 *
 * @example
 * ```typescript
 * import { Market, MarketState, asMarketDuration } from '@polymarket/market';
 * import { unsafeMarketId, unsafeInstrumentId, unsafeCryptoAssetId, KnownVenues } from '@polymarket/ids';
 * import { TimestampService } from '@polymarket/timestamp';
 *
 * const startsAt = TimestampService.fromISO('2026-09-01T12:00:00.000Z');
 * const expiresAt = TimestampService.fromISO('2026-09-01T12:05:00.000Z');
 * if (!startsAt.ok || !expiresAt.ok) throw new Error('bad schedule');
 *
 * const result = Market.create({
 *   id: unsafeMarketId('btc-up-down-1200'),
 *   venueId: KnownVenues.POLYMARKET,
 *   question: 'Bitcoin Up or Down — 12:00 to 12:05?',
 *   startsAt: startsAt.value,
 *   expiresAt: expiresAt.value,
 *   state: MarketState.active(),
 *   outcomes: [
 *     { index: 0, label: 'Up', instrumentId: unsafeInstrumentId('7147...') },
 *     { index: 1, label: 'Down', instrumentId: unsafeInstrumentId('2299...') },
 *   ],
 *   family: 'CRYPTO_UP_DOWN',
 *   crypto: { asset: unsafeCryptoAssetId('btc'), duration: asMarketDuration(5 * 60_000)! },
 * });
 *
 * if (result.ok) {
 *   const market = result.value;
 *   const closed = market.markClosed();          // площадка подтвердила закрытие
 *   if (closed.ok) {
 *     const resolved = closed.value.markResolved(0); // победил Up
 *   }
 * }
 * ```
 */

import type Decimal from 'decimal.js';
import { Result, Ok, Err } from '@polymarket/result';
import type { MarketAlreadyResolvedError } from '@polymarket/errors/market';
import { MarketValidationError } from '@polymarket/errors/market';
import { Timestamp } from '@polymarket/timestamp';
import {
  type MarketId,
  type VenueId,
  type MarketSlug,
  type MarketOutcome,
  type MarketFamily,
  type CryptoUpDownSpec,
  type OutcomeIndex,
  MarketState,
  isActive,
  isClosed,
  isResolved,
  isValidMarketFamily,
  asMarketDuration,
  asMarketId,
  asVenueId,
  asInstrumentId,
  asCryptoAssetId,
  parseMarketSlug,
} from './value-objects/index.js';
import { type MarketSnapshot } from './view/MarketSnapshot.js';

/**
 * MarketProps — параметры создания Market
 *
 * @remarks
 * Используется в {@link Market.create}. Структурно совпадает с
 * {@link MarketSnapshot} — поэтому `Market.fromSnapshot()` делегирует в `create()`.
 * Все поля readonly.
 */
export interface MarketProps {
  /** Идентификатор рынка в пространстве имён площадки */
  readonly id: MarketId;
  /** Площадка, на которой наблюдается рынок */
  readonly venueId: VenueId;
  /**
   * URL-safe слаг рынка, если площадка его публикует.
   *
   * @remarks
   * Необязателен: слаг есть не у каждой площадки, и Domain не строит по нему
   * ссылок (это делает presentation-слой конкретной площадки).
   */
  readonly slug?: MarketSlug;
  /** Вопрос рынка (человекочитаемое описание) */
  readonly question: string;
  /** Запланированное начало торгов */
  readonly startsAt: Timestamp;
  /** Запланированное окончание торгов */
  readonly expiresAt: Timestamp;
  /** Подтверждённое внешнее состояние рынка */
  readonly state: MarketState;
  /** Исходы рынка: ровно два, с различными canonical instrument identity */
  readonly outcomes: readonly [MarketOutcome, MarketOutcome];
  /** Семейство рынка — как он устроен структурно */
  readonly family: MarketFamily;
  /**
   * Спецификация семейства `CRYPTO_UP_DOWN`.
   *
   * @remarks
   * Обязательна при `family === 'CRYPTO_UP_DOWN'` и запрещена при любом другом
   * семействе — обе стороны правила проверяет `create()`.
   */
  readonly crypto?: CryptoUpDownSpec;
}

/**
 * Market — неизменяемая доменная сущность наблюдаемого внешнего рынка
 *
 * @remarks
 * Полное описание модели, границ и того, что намеренно не входит в Market —
 * в TSDoc модуля в начале файла.
 */
export class Market {
  /** Идентификатор рынка в пространстве имён площадки */
  public readonly id: MarketId;
  /** Площадка, на которой наблюдается рынок */
  public readonly venueId: VenueId;
  /**
   * URL-safe слаг рынка, если площадка его публикует
   *
   * @remarks
   * `declare` здесь не косметика и не лишнее слово. Без него TypeScript при
   * `target: ES2022` эмитирует объявление поля, и класс определяет ключ даже
   * когда значения нет: `'slug' in market` возвращал бы `true` со значением
   * `undefined`. Снапшот и JSON в этом случае ключ **не** содержат — получалась
   * бы асимметрия, на которой ломается любой потребитель, проверяющий наличие
   * через `in`, а не через `!== undefined` (такие дефекты в сериализаторах
   * репозитория уже находили). С `declare` поле появляется только при
   * присваивании в конструкторе: «нет значения» означает «нет ключа» везде.
   */
  public declare readonly slug?: MarketSlug;
  /** Вопрос рынка */
  public readonly question: string;
  /** Запланированное начало торгов */
  public readonly startsAt: Timestamp;
  /** Запланированное окончание торгов */
  public readonly expiresAt: Timestamp;
  /** Подтверждённое внешнее состояние рынка */
  public readonly state: MarketState;
  /** Исходы рынка: ровно два */
  public readonly outcomes: readonly [MarketOutcome, MarketOutcome];
  /** Семейство рынка */
  public readonly family: MarketFamily;
  /**
   * Спецификация семейства `CRYPTO_UP_DOWN`; у `BINARY_OUTCOME` отсутствует
   *
   * @remarks
   * `declare` — по той же причине, что и у {@link Market.slug}: иначе ключ
   * `crypto` существовал бы на рынке семейства, которому спецификация запрещена.
   */
  public declare readonly crypto?: CryptoUpDownSpec;

  /**
   * Приватный конструктор — используйте {@link Market.create}
   *
   * @param props - Уже провалидированные параметры рынка
   *
   * @remarks
   * Нормализует метки исходов (`trim`) — так хранимое значение совпадает с тем,
   * которое сравнивалось на различимость в `create()`.
   *
   * Состояние пересоздаётся через `MarketState.normalize()`, а не сохраняется по
   * ссылке: `props.state` мог прийти изменяемым литералом, и тогда мутация у
   * вызывающего меняла бы «иммутабельную» entity. Исходы и crypto-спецификация
   * замораживаются здесь же и по той же причине.
   */
  private constructor(props: MarketProps) {
    this.id = props.id;
    this.venueId = props.venueId;
    this.question = props.question.trim();
    this.startsAt = props.startsAt;
    this.expiresAt = props.expiresAt;
    this.state = MarketState.normalize(props.state);
    this.family = props.family;
    this.outcomes = Object.freeze([
      Object.freeze({ ...props.outcomes[0], label: props.outcomes[0].label.trim() }),
      Object.freeze({ ...props.outcomes[1], label: props.outcomes[1].label.trim() }),
    ]) as readonly [MarketOutcome, MarketOutcome];
    if (props.slug !== undefined) {
      this.slug = props.slug;
    }
    if (props.crypto !== undefined) {
      this.crypto = Object.freeze({ ...props.crypto });
    }
  }

  // ==================== Factory ====================

  /**
   * Создаёт Market с валидацией доменных инвариантов
   *
   * @param props - Параметры создания рынка
   * @returns `Result` с Market либо `MarketValidationError`
   * @throws Ничего не бросает — все нарушения возвращаются как `Err`
   *
   * @remarks
   * Проверяемые инварианты:
   * 1. `id`, `venueId` и (если задан) `slug` — уже канонические значения своих VO:
   *    `unsafe*`-конструкторы валидацию обходят, поэтому она повторяется здесь;
   * 2. `question` — непустая строка;
   * 3. ровно два исхода, позиции 0 и 1 на своих местах;
   * 4. метки исходов непустые и различные;
   * 5. instrument identity исходов канонические и различные (один outcome → одна identity);
   * 6. расписание: оба конца — `Timestamp`, `startsAt < expiresAt`;
   * 7. `state` — валидный `MarketState`; для RESOLVED индекс победителя указывает на существующий исход;
   * 8. `family` — известное семейство; `CRYPTO_UP_DOWN` требует валидную
   *    `crypto`-спецификацию, любое другое семейство её запрещает.
   *
   * Проверки идентификаторов строгие: значение должно совпадать с результатом
   * своего парсера VO. Благодаря этому `Market.create()` и `MarketParser.from()`
   * принимают ровно одно и то же множество значений, и round-trip
   * `Market → JSON → Market` замыкается без исключений.
   *
   * Часть проверок дублирует то, что уже гарантирует система типов — это
   * runtime-защита на границе с внешними данными (JSON, БД, `as`-касты).
   *
   * @example
   * ```typescript
   * const result = Market.create(props);
   * if (!result.ok) {
   *   logger.error('Invalid market', { field: result.error.context?.field });
   * }
   * ```
   */
  public static create(props: MarketProps): Result<Market, MarketValidationError> {
    const identity = Market._validateIdentity(props);
    if (identity !== undefined) return Err(identity);

    const outcomes = Market._validateOutcomes(props);
    if (outcomes !== undefined) return Err(outcomes);

    const schedule = Market._validateSchedule(props);
    if (schedule !== undefined) return Err(schedule);

    const state = Market._validateState(props);
    if (state !== undefined) return Err(state);

    const family = Market._validateFamily(props);
    if (family !== undefined) return Err(family);

    return Ok(new Market(props));
  }

  /**
   * Реконструирует Market из доменно-типизированного снапшота
   *
   * @param snapshot - {@link MarketSnapshot} из `MarketParser.from()` или `MarketViewModel.toSnapshot()`
   * @returns `Result` с Market либо `MarketValidationError`
   * @throws Ничего не бросает — все нарушения возвращаются как `Err`
   *
   * @remarks
   * `MarketSnapshot` структурно идентичен {@link MarketProps}, поэтому метод
   * делегирует в `Market.create()` — доменные инварианты проверяются там же,
   * что и при первичном создании. Реконструкция состояния не является новым
   * наблюдением и никаких побочных эффектов не порождает.
   *
   * @example
   * ```typescript
   * const snapshotResult = MarketParser.from(await db.load(id));
   * if (!snapshotResult.ok) return;
   * const marketResult = Market.fromSnapshot(snapshotResult.value);
   * ```
   */
  public static fromSnapshot(snapshot: MarketSnapshot): Result<Market, MarketValidationError> {
    return Market.create(snapshot);
  }

  // ==================== Validation helpers ====================

  /**
   * Проверяет identity-поля рынка (id, venueId, slug, question)
   *
   * @param props - Параметры создания рынка
   * @returns `MarketValidationError` при нарушении, иначе `undefined`
   *
   * @remarks
   * Проверка строгая: значение должно быть **уже каноническим**, то есть
   * совпадать с тем, что вернул бы соответствующий парсер VO
   * (`asMarketId`/`asVenueId`/`parseMarketSlug`). Не «почти валидное»
   * значение не нормализуется молча, а отклоняется.
   *
   * Почему так, а не «принять и обрезать»: `unsafe*`-конструкторы обходят
   * валидацию, поэтому `unsafeMarketId(' x ')` дал бы entity с id `' x '`,
   * тогда как `asMarketId(' x ')` дал бы `'x'`. Два объекта одного и того же
   * рынка перестали бы быть равны в `equals()`, а `Market → JSON → MarketParser`
   * ломался бы уже на парсере — round-trip канонической сущности обязан
   * замыкаться. Единственный способ этого добиться — не пускать
   * неканоническое значение внутрь.
   */
  private static _validateIdentity(props: MarketProps): MarketValidationError | undefined {
    if (typeof props.id !== 'string' || asMarketId(props.id) !== props.id) {
      return new MarketValidationError('Market id must be a canonical MarketId', {
        context: { field: 'id', value: props.id },
      });
    }
    if (typeof props.venueId !== 'string' || asVenueId(props.venueId) !== props.venueId) {
      return new MarketValidationError('Market venueId must be a canonical VenueId', {
        context: { field: 'venueId', value: props.venueId },
      });
    }
    if (props.slug !== undefined
      && (typeof props.slug !== 'string' || parseMarketSlug(props.slug) !== props.slug)) {
      return new MarketValidationError('Market slug must be a canonical MarketSlug', {
        context: { field: 'slug', value: props.slug },
      });
    }
    if (typeof props.question !== 'string' || props.question.trim().length === 0) {
      return new MarketValidationError('Market question must be a non-empty string', {
        context: { field: 'question', value: props.question },
      });
    }
    return undefined;
  }

  /**
   * Проверяет набор исходов рынка
   *
   * @param props - Параметры создания рынка
   * @returns `MarketValidationError` при нарушении, иначе `undefined`
   *
   * @remarks
   * Ключевой инвариант — различные `instrumentId`: один outcome обязан иметь
   * ровно одну canonical instrument identity, и две разные позиции рынка не
   * могут указывать на один и тот же инструмент.
   */
  private static _validateOutcomes(props: MarketProps): MarketValidationError | undefined {
    if (
      !Array.isArray(props.outcomes) ||
      props.outcomes.length !== 2 ||
      !props.outcomes[0] ||
      !props.outcomes[1]
    ) {
      return new MarketValidationError('Market outcomes must have exactly 2 elements', {
        context: {
          field: 'outcomes',
          length: Array.isArray(props.outcomes) ? props.outcomes.length : 'not array',
        },
      });
    }

    for (const position of [0, 1] as const) {
      const outcome = props.outcomes[position];
      if (outcome.index !== position) {
        return new MarketValidationError(
          `Outcome at position ${position} must have index ${position}`,
          { context: { field: `outcomes[${position}].index`, value: outcome.index } }
        );
      }
      if (typeof outcome.label !== 'string' || outcome.label.trim().length === 0) {
        return new MarketValidationError(
          `Outcome label at index ${position} must be a non-empty string`,
          { context: { field: `outcomes[${position}].label`, value: outcome.label } }
        );
      }
      if (typeof outcome.instrumentId !== 'string'
        || asInstrumentId(outcome.instrumentId) !== outcome.instrumentId) {
        return new MarketValidationError(
          `Outcome instrumentId at index ${position} must be a canonical InstrumentId`,
          { context: { field: `outcomes[${position}].instrumentId`, value: outcome.instrumentId } }
        );
      }
    }

    if (props.outcomes[0].label.trim() === props.outcomes[1].label.trim()) {
      return new MarketValidationError('Outcome labels must be distinct', {
        context: {
          field: 'outcomes',
          value: [props.outcomes[0].label.trim(), props.outcomes[1].label.trim()],
        },
      });
    }

    if (props.outcomes[0].instrumentId === props.outcomes[1].instrumentId) {
      return new MarketValidationError('Outcome instrument identities must be distinct', {
        context: { field: 'outcomes', value: props.outcomes[0].instrumentId },
      });
    }

    return undefined;
  }

  /**
   * Проверяет расписание рынка
   *
   * @param props - Параметры создания рынка
   * @returns `MarketValidationError` при нарушении, иначе `undefined`
   *
   * @remarks
   * Инвариант `startsAt < expiresAt` строгий: рынок нулевой длительности
   * не наблюдаем и ломает вычисление фазы.
   */
  private static _validateSchedule(props: MarketProps): MarketValidationError | undefined {
    if (!(props.startsAt instanceof Timestamp)) {
      return new MarketValidationError('Market startsAt must be a Timestamp', {
        context: { field: 'startsAt', type: typeof props.startsAt },
      });
    }
    if (!(props.expiresAt instanceof Timestamp)) {
      return new MarketValidationError('Market expiresAt must be a Timestamp', {
        context: { field: 'expiresAt', type: typeof props.expiresAt },
      });
    }
    if (!props.startsAt.isBefore(props.expiresAt)) {
      return new MarketValidationError('Market startsAt must be strictly before expiresAt', {
        context: {
          field: 'startsAt',
          startsAt: props.startsAt.toISO(),
          expiresAt: props.expiresAt.toISO(),
        },
      });
    }
    return undefined;
  }

  /**
   * Проверяет подтверждённое внешнее состояние рынка
   *
   * @param props - Параметры создания рынка
   * @returns `MarketValidationError` при нарушении, иначе `undefined`
   */
  private static _validateState(props: MarketProps): MarketValidationError | undefined {
    if (
      !props.state ||
      typeof props.state !== 'object' ||
      !['ACTIVE', 'CLOSED', 'RESOLVED'].includes(props.state.status)
    ) {
      return new MarketValidationError('Market state must be a valid MarketState object', {
        context: {
          field: 'state',
          value: props.state ? props.state.status : props.state,
        },
      });
    }

    // RESOLVED без валидного индекса победителя — невозможное состояние,
    // которое TypeScript исключает статически, но `as`-касты и JSON могут обойти.
    if (props.state.status === 'RESOLVED') {
      const index = props.state.resolvedOutcomeIndex;
      if (index !== 0 && index !== 1) {
        return new MarketValidationError(
          'Market state RESOLVED requires resolvedOutcomeIndex of 0 or 1',
          { context: { field: 'state.resolvedOutcomeIndex', value: index } }
        );
      }
    }

    return undefined;
  }

  /**
   * Проверяет семейство рынка и его спецификацию
   *
   * @param props - Параметры создания рынка
   * @returns `MarketValidationError` при нарушении, иначе `undefined`
   *
   * @remarks
   * Связка «семейство → спецификация» проверяется здесь, а не типом, и в обе
   * стороны: `CRYPTO_UP_DOWN` требует `crypto`, любое другое семейство её
   * запрещает. Здесь правило записано целиком и действует для любого способа
   * создания рынка.
   *
   * `MarketParser` проверяет его повторно — намеренно: без своей проверки
   * парсеру пришлось бы молча отбрасывать `crypto` у не-crypto семейства, и
   * повреждённые данные дошли бы сюда уже вычищенными. Дубль превращает тихую
   * потерю в `Err`; сам инвариант остаётся определённым в этом методе.
   */
  private static _validateFamily(props: MarketProps): MarketValidationError | undefined {
    if (!isValidMarketFamily(props.family)) {
      return new MarketValidationError('Market family must be a known MarketFamily', {
        context: { field: 'family', value: props.family },
      });
    }

    // Семейства без предметной спецификации не должны её нести: иначе
    // BINARY_OUTCOME стал бы дырой для crypto-данных рынка, который их не имеет.
    if (props.family !== 'CRYPTO_UP_DOWN' && props.crypto !== undefined) {
      return new MarketValidationError(
        `Market family ${props.family} must not carry a crypto spec`,
        { context: { field: 'crypto', family: props.family } }
      );
    }

    if (props.family === 'CRYPTO_UP_DOWN') {
      const crypto = props.crypto;
      if (!crypto || typeof crypto !== 'object') {
        return new MarketValidationError(
          'Market family CRYPTO_UP_DOWN requires a crypto spec',
          { context: { field: 'crypto', value: crypto } }
        );
      }
      if (typeof crypto.asset !== 'string' || asCryptoAssetId(crypto.asset) !== crypto.asset) {
        return new MarketValidationError('Crypto spec asset must be a canonical CryptoAssetId', {
          context: { field: 'crypto.asset', value: crypto.asset },
        });
      }
      if (asMarketDuration(crypto.duration) === undefined) {
        return new MarketValidationError(
          'Crypto spec duration must be a positive integer number of milliseconds',
          { context: { field: 'crypto.duration', value: crypto.duration } }
        );
      }
    }

    return undefined;
  }

  // ==================== Getters ====================

  /**
   * Победивший исход, если рынок разрешён
   *
   * @returns {@link MarketOutcome} победителя либо `undefined`, если состояние не RESOLVED
   *
   * @remarks
   * `MarketState` хранит только индекс победителя — единственную ссылку,
   * которая не может разойтись с массивом `outcomes`. Этот getter разворачивает
   * индекс в сам исход, чтобы вызывающему не приходилось индексировать вручную.
   *
   * @example
   * ```typescript
   * const winner = resolvedMarket.resolvedOutcome;
   * if (winner) {
   *   settlement.payout(winner.instrumentId);
   * }
   * ```
   */
  public get resolvedOutcome(): MarketOutcome | undefined {
    return isResolved(this.state) ? this.outcomes[this.state.resolvedOutcomeIndex] : undefined;
  }

  // ==================== Time ====================

  /**
   * Начались ли торги к заданному моменту
   *
   * @param now - Момент наблюдения
   * @returns true если `now >= startsAt`
   *
   * @remarks
   * Момент передаётся явно: Market не обращается к часам сам. «Сейчас»
   * вызывающий берёт из инжектированного `IClock` (live/paper/replay), поэтому
   * сравнения детерминированы и одинаковы во всех режимах. No-arg перегрузок
   * нет намеренно — они тихо падали бы обратно на wall-clock.
   *
   * @example
   * ```typescript
   * market.isStartedAt(Timestamp.now(clock)); // → true после startsAt
   * ```
   */
  public isStartedAt(now: Timestamp): boolean {
    return now.isAfterOrEqual(this.startsAt);
  }

  /**
   * Истекло ли расписание рынка к заданному моменту
   *
   * @param now - Момент наблюдения
   * @returns true если `now >= expiresAt`
   *
   * @remarks
   * Истечение расписания **не** означает, что рынок закрыт: `state` меняется
   * только по подтверждению площадки (см. `markClosed()`).
   *
   * @example
   * ```typescript
   * market.isExpiredAt(Timestamp.now(clock)); // → true после expiresAt
   * ```
   */
  public isExpiredAt(now: Timestamp): boolean {
    return now.isAfterOrEqual(this.expiresAt);
  }

  /**
   * Время до начала торгов
   *
   * @param now - Момент наблюдения
   * @returns Миллисекунды до `startsAt` как `Decimal` (отрицательное, если торги уже начались)
   *
   * @example
   * ```typescript
   * const waitMs = market.timeToStartAt(now);
   * if (waitMs.greaterThan(0)) scheduler.subscribeIn(waitMs);
   * ```
   */
  public timeToStartAt(now: Timestamp): Decimal {
    return this.startsAt.diffMs(now);
  }

  /**
   * Время до окончания торгов
   *
   * @param now - Момент наблюдения
   * @returns Миллисекунды до `expiresAt` как `Decimal` (отрицательное, если срок истёк)
   *
   * @example
   * ```typescript
   * const remaining = market.timeToExpiryAt(now);
   * if (remaining.lessThan(30_000)) strategy.stopEntering();
   * ```
   */
  public timeToExpiryAt(now: Timestamp): Decimal {
    return this.expiresAt.diffMs(now);
  }

  /**
   * Фактическая запланированная длительность рынка
   *
   * @returns `expiresAt - startsAt` в миллисекундах как `Decimal` (всегда > 0)
   *
   * @remarks
   * Это измеренный интервал расписания. Номинальную длительность серии
   * (5 минут, час) для crypto-рынков даёт `crypto.duration` — значения обычно
   * совпадают, но совпадение не гарантируется, см. TSDoc `MarketDuration`.
   *
   * @example
   * ```typescript
   * const durationMs = market.duration().toNumber(); // 300000 для 5-минутного рынка
   * ```
   */
  public duration(): Decimal {
    return this.expiresAt.diffMs(this.startsAt);
  }

  // ==================== Predicates ====================

  /**
   * Публикует ли площадка рынок как активный
   *
   * @returns true если `state.status === 'ACTIVE'`
   *
   * @remarks
   * ACTIVE ничего не говорит о времени: рынок может быть ещё не начат или уже
   * истёк. Для торговых решений используйте `MarketTradingPolicy.getPhase()`.
   *
   * @example
   * ```typescript
   * if (market.isActive()) {
   *   // площадка считает рынок активным
   * }
   * ```
   */
  public isActive(): boolean {
    return isActive(this.state);
  }

  /**
   * Подтвердила ли площадка закрытие торгов
   *
   * @returns true если `state.status === 'CLOSED'`
   *
   * @example
   * ```typescript
   * if (market.isClosed()) {
   *   // торги остановлены, ждём объявления исхода
   * }
   * ```
   */
  public isClosed(): boolean {
    return isClosed(this.state);
  }

  /**
   * Объявила ли площадка победивший исход
   *
   * @returns true если `state.status === 'RESOLVED'`
   *
   * @example
   * ```typescript
   * if (market.isResolved()) {
   *   // исход объявлен — можно считать settlement
   * }
   * ```
   */
  public isResolved(): boolean {
    return isResolved(this.state);
  }

  // ==================== Identity ====================

  /**
   * Сравнивает два Market по идентичности сущности
   *
   * @param other - Другой Market
   * @returns true если это один и тот же рынок одной и той же площадки
   *
   * @remarks
   * Entity определяется идентичностью, а не ссылкой: два объекта с разным
   * `state`, но одинаковыми `venueId` + `id` — это одна сущность в разных
   * наблюдениях. `venueId` входит в сравнение, потому что `MarketId` уникален
   * только внутри пространства имён своей площадки.
   *
   * @example
   * ```typescript
   * const closed = market.markClosed();
   * closed.ok && market.equals(closed.value); // → true
   * ```
   */
  public equals(other: Market): boolean {
    return this.venueId === other.venueId && this.id === other.id;
  }

  // ==================== Observed state transitions ====================

  /**
   * Создаёт копию рынка с новым подтверждённым состоянием
   *
   * @param state - Новое состояние
   * @returns Новый Market с той же структурой и другим `state`
   *
   * @remarks
   * Централизует копирование props — изменение структуры затрагивает одно место.
   */
  private _withState(state: MarketState): Market {
    return new Market({
      id: this.id,
      venueId: this.venueId,
      ...(this.slug !== undefined ? { slug: this.slug } : {}),
      question: this.question,
      startsAt: this.startsAt,
      expiresAt: this.expiresAt,
      state,
      outcomes: this.outcomes,
      family: this.family,
      ...(this.crypto !== undefined ? { crypto: this.crypto } : {}),
    });
  }

  /**
   * Фиксирует наблюдённое закрытие торгов (ACTIVE → CLOSED)
   *
   * @returns `Result` с Market в состоянии CLOSED либо ошибкой конфликта наблюдений
   * @throws Ничего не бросает — конфликт возвращается как `Err`
   *
   * @remarks
   * Название отражает семантику: мы **отмечаем** подтверждённое площадкой
   * закрытие, а не приказываем внешнему рынку закрыться. Вызывать только после
   * подтверждения от источника; истечение `expiresAt` подтверждением не является.
   *
   * Повторное наблюдение на уже закрытом рынке идемпотентно и возвращает
   * **тот же экземпляр** — по `Ok(result.value === market)` вызывающий отличает
   * «ничего не изменилось» от реального перехода, не сравнивая состояния.
   *
   * Правила перехода живут в `MarketState.markClosed()` — entity их не знает
   * и только пробрасывает `Result` наверх (по ADR `docs/architecture/
   * boundary-contract.md`, Решение 2 — throw легитимен только внутри `value-objects`).
   *
   * @example
   * ```typescript
   * const result = market.markClosed();
   * if (!result.ok) logger.warn('Close observation rejected', { code: result.error.name });
   * else if (result.value === market) logger.debug('Market was already closed');
   * ```
   */
  public markClosed(): Result<Market, MarketAlreadyResolvedError> {
    const next = MarketState.markClosed(this.state, { marketId: this.id, venueId: this.venueId });
    if (!next.ok) return Err(next.error);
    return Ok(next.value === this.state ? this : this._withState(next.value));
  }

  /**
   * Фиксирует объявленный площадкой исход (CLOSED → RESOLVED)
   *
   * @param outcomeIndex - Индекс победившего исхода в `outcomes`
   * @returns `Result` с Market в состоянии RESOLVED либо ошибкой валидации/конфликта
   * @throws Ничего не бросает — все нарушения возвращаются как `Err`
   *
   * @remarks
   * Как и `markClosed()`, это фиксация внешнего наблюдения. Допустим переход и
   * из ACTIVE: между опросами источника рынок мог успеть закрыться и
   * разрезолвиться, и промежуточный CLOSED мы просто не увидели.
   *
   * Повторная резолюция тем же исходом идемпотентна и возвращает **тот же
   * экземпляр**; резолюция другим исходом — конфликт данных источника и `Err`.
   *
   * Индекс проверяется против фактического набора исходов: резолюция по
   * несуществующему исходу — это ошибка данных источника, а не переход FSM.
   *
   * @example
   * ```typescript
   * const result = closedMarket.markResolved(0);
   * if (result.ok) {
   *   console.log(result.value.resolvedOutcome?.label); // 'Up'
   * }
   * ```
   */
  public markResolved(
    outcomeIndex: OutcomeIndex,
  ): Result<Market, MarketValidationError | MarketAlreadyResolvedError> {
    if (
      typeof outcomeIndex !== 'number' ||
      !Number.isInteger(outcomeIndex) ||
      outcomeIndex < 0 ||
      outcomeIndex >= this.outcomes.length
    ) {
      return Err(new MarketValidationError('resolvedOutcomeIndex must be a valid outcome index', {
        context: {
          field: 'outcomeIndex',
          value: outcomeIndex,
          validRange: `0..${this.outcomes.length - 1}`,
        },
      }));
    }

    const next = MarketState.markResolved(this.state, outcomeIndex, {
      marketId: this.id,
      venueId: this.venueId,
    });
    if (!next.ok) return Err(next.error);
    return Ok(next.value === this.state ? this : this._withState(next.value));
  }

  // ==================== String Representation ====================

  /**
   * Строковое представление рынка
   *
   * @returns Строка вида `Market[VENUE:id](STATUS): question`
   *
   * @example
   * ```typescript
   * console.log(market.toString());
   * // 'Market[POLYMARKET:btc-up-down-1200](ACTIVE): Bitcoin Up or Down — 12:00 to 12:05?'
   * ```
   */
  public toString(): string {
    return `Market[${this.venueId}:${this.id}](${this.state.status}): ${this.question}`;
  }
}

/**
 * LEGACY-контракт кандидата обнаружения рынков.
 *
 * @remarks
 * `DiscoveredMarket` — прежняя (до canonical `Market`) форма кандидата
 * discovery: плоский DTO, совмещающий identity инструмента, торговые
 * параметры и БЫСТРО МЕНЯЮЩИЕСЯ наблюдения (`spread`, `liquidity`, `score`).
 *
 * ### Почему он ещё здесь
 *
 * Контракт остаётся ИСКЛЮЧИТЕЛЬНО как вход LEGACY V1-адаптера
 * (`PolymarketMarketDiscoveryAdapter`). Новый Polymarket V2 Discovery его
 * больше не производит: за vendor-границей живёт canonical `Market` плюс
 * отдельные {@link MarketDiscoveryMetrics} (см. `IMarketDiscoveryService.ts`),
 * а отбор по ним делает `@polymarket/policy`.
 *
 * Файл исчезнет вместе с V1-путём. Он НЕ удалён «за компанию» с
 * `IMarketFilterConfig` только потому, что V1-адаптер ещё существует, и его
 * вырезание относится к отдельной задаче, а не к этой.
 *
 * @deprecated Используйте `MarketDiscoveryEntry` из `IMarketDiscoveryService.ts`.
 */
import type Decimal from 'decimal.js';
import type { InstrumentInfo } from './IMarketCatalog.js';
import type { Money, Ratio } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';

/**
 * Обнаруженный рынок — legacy-кандидат для торговли.
 *
 * @remarks
 * Расширяет `InstrumentInfo` — содержит все данные, необходимые для прямой
 * регистрации в каталоге через `catalog.register(candidate)`. Поля `spread`,
 * `liquidity` и `score` используются для фильтрации и приоритизации рынков
 * V1-адаптером при отборе кандидатов.
 *
 * `active: true` — литеральный тип: кандидат всегда активен по определению
 * (неактивные рынки отфильтровываются в адаптере ещё до создания DiscoveredMarket).
 *
 * @deprecated См. TSDoc модуля — контракт живёт до миграции Filter/Scorer.
 */
export interface DiscoveredMarket extends InstrumentInfo {
  /** Кандидат всегда активен (narrowed from boolean → true) */
  readonly active: true;
  /** Вопрос рынка (человекочитаемое описание) */
  readonly question: string;
  /**
   * Текущий спред (bid-ask), доля от 1 (0.02 = 2%). `undefined` если
   * недоступен (нет данных от API).
   */
  readonly spread?: Ratio;
  /** Ликвидность (объём торгов, USDC notional). `Money.of(0, 'USDC')` если недоступна. */
  readonly liquidity: Money;
  /**
   * Скор рынка — устанавливается `MarketScorer`.
   * До скоринга = Decimal('0'). После = hoursToExpiry как Decimal.
   *
   * @remarks
   * Остаётся `Decimal` (не VO) — внутренний sort-key без чистого VO-отображения,
   * см. Этап 10c плана миграции.
   */
  readonly score: Decimal;
  /**
   * Все token ID рынка (UP + DOWN) из `clobTokenIds`.
   * Используется для подписки и маршрутизации событий обоих исходов.
   * Если не задан — только `instrumentId` (UP token).
   */
  readonly allTokenIds?: readonly string[];
  /**
   * Полные сырые данные рынка из REST API (опционально).
   * Устанавливается адаптером и передаётся в `MarketMeta.rawMarket`
   * для записи в meta-строку снапшота.
   */
  readonly rawMarket?: Record<string, unknown>;
  /**
   * Начало торгового окна события — Gamma-поле рынка `eventStartTime`
   * (то же значение, что `events[0].startTime`).
   *
   * @remarks
   * Заполняется единственным производителем контракта —
   * `PolymarketMarketDiscoveryAdapter._mapToDiscoveredMarket()`. Ошибка разбора
   * даёт `undefined`, а не отбрасывание рынка: длительность — критерий отбора,
   * а не часть identity кандидата.
   *
   * Читатель ровно один — duration-фильтр `MarketFilter`
   * (`expiresAt − eventStartMs` против `min/maxDurationMinutes`). Там
   * `undefined` означает «данных нет» и рынок фильтр ПРОПУСКАЕТ: отклонять по
   * неизвестной длительности значило бы терять кандидатов из-за пробела в
   * ответе площадки.
   *
   * Для крипто-серий Up/Down это и есть начало торгов рынка: окно
   * `startTime..endDate` — то самое, на границах которого площадка снимает
   * TWAP-наблюдения. Отдельного «начала расписания рынка», отличного от начала
   * события, в payload'е Gamma нет вовсе — поэтому соседнее `startsAt` вторым
   * источником этого времени не является и никогда им не было.
   */
  readonly eventStartMs?: Timestamp;
  /**
   * Начало записи/торговли ботом. В текущем контуре ФАНТОМНОЕ поле — его не
   * заполняет никто и не читает никто.
   *
   * @remarks
   * ### Почему поле пустое
   *
   * Поле вводилось для выравнивания записи по границе начала рынка (аналог CEX
   * window alignment) и заполнялось из `events[0].startDate`. Источник оказался
   * не тем: `startDate` — момент ПУБЛИКАЦИИ записи события в Gamma, а не начало
   * торгов, и расходится с границей окна примерно на сутки (замер на
   * 5-минутном Solana Up/Down: `startDate` = 2026-03-25T10:02:25Z при окне
   * 2026-03-26T09:50–09:55Z, где `events[0].startTime` = `eventStartTime` =
   * 09:50). Выравнивание по такому значению всегда попадало в прошлое, то есть
   * запись стартовала немедленно — ровно тот дефект, против которого поле и
   * заводилось. Источник убрали, поле осталось.
   *
   * Единственный производитель контракта
   * (`PolymarketMarketDiscoveryAdapter._mapToDiscoveredMarket()`) `startsAt`
   * сознательно не ставит. Момент старта записи вызывающая сторона получает
   * мимо этого поля: `MarketMeta.startsAt` собирается из crypto-меты
   * (`cryptoMeta.eventStartTimeMs`), а V2-контур пишет с момента открытия
   * сессии коллектора.
   *
   * ### Где брать честное время начала торгов
   *
   * В canonical-контуре: `Market.startsAt`, который `PolymarketMarketDiscovery`
   * строит строго из `event.schedule.startTime` и без которого рынок вообще не
   * попадает в universe — подставного расписания там нет по построению.
   *
   * Поле не удаляется, потому что уедет целиком вместе с legacy-контрактом в
   * Policy-MR (см. TSDoc модуля).
   *
   * @deprecated Никогда не заполняется; начало торгов даёт `Market.startsAt`.
   */
  readonly startsAt?: Timestamp;
}

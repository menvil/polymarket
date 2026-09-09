/**
 * Записи наблюдений, из которых состоят временные ряды hot state.
 *
 * @remarks
 * Каждая запись хранит ДВА времени, и путать их нельзя:
 *
 * - **`observedAt`** — момент, когда canonical-событие появилось в нашей
 *   системе (`event.metadata.createdAt`). По нему работает retention и по
 *   нему определяется порядок наблюдений. Это единственное время, на которое
 *   опирается поведение состояния, поэтому replay той же последовательности
 *   даёт тот же результат.
 * - **`sourceTimestamp`** (или `venueTimestamp`) — время, которое сообщила
 *   площадка. Оно хранится как ДАННЫЕ: нужно для анализа задержки и
 *   свежести, но идти назад относительно порядка наблюдений оно может
 *   свободно, и состояние от этого не должно ломаться.
 *
 * Wall-clock (`Date.now()`) не используется нигде.
 */
import type { InstrumentId, MarketDataSourceId, VenueTradeId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/timestamp';
import type { Orderbook } from '@polymarket/orderbook';
import type { TopOfBook } from '@polymarket/application-events';
import type { AssetPrice, DecimalPrice, Quantity, Side } from '@polymarket/value-objects';

/** Общая часть любого наблюдения: когда мы его увидели. */
export interface Observation {
  /**
   * Момент появления canonical-события в системе.
   *
   * @remarks
   * `event.metadata.createdAt`. Retention и порядок считаются по нему.
   */
  readonly observedAt: Timestamp;
}

/**
 * Верхушка стакана в момент наблюдения.
 *
 * @remarks
 * Не путать с полным стаканом: `BOOK_UPDATED` несёт только лучшие цены и
 * их объёмы, а `BOOK_DEPTH` — снимок целиком. Это разные ряды.
 */
export interface TopOfBookObservation extends Observation {
  /** Лучшие bid/ask и их объёмы */
  readonly topOfBook: TopOfBook<DecimalPrice>;
  /**
   * Монотонный номер обновления для одного инструмента.
   *
   * @remarks
   * По нему отбрасываются устаревшие и повторные обновления — см.
   * {@link MarketInstrumentState}.
   */
  readonly sequenceNumber: number;
  /** Время площадки из payload — данные, не порядок */
  readonly sourceTimestamp: Timestamp;
}

/** Снимок полного стакана в момент наблюдения. */
export interface BookObservation extends Observation {
  /**
   * Снимок стакана.
   *
   * @remarks
   * `Orderbook` immutable — храним ссылку, а не копию: пересобирать
   * собственный DTO значило бы удвоить память ради ничего.
   */
  readonly snapshot: Orderbook<DecimalPrice>;
  /** Время площадки из payload — данные, не порядок */
  readonly sourceTimestamp: Timestamp;
}

/** Публичная сделка на площадке в момент наблюдения. */
export interface PublicTradeObservation extends Observation {
  /**
   * Идентификатор сделки у площадки.
   *
   * @remarks
   * `undefined`, если площадка его не сообщила. Синтезировать нельзя:
   * выдуманный идентификатор нельзя ни сопоставить с площадкой, ни
   * отличить от настоящего.
   */
  readonly venueTradeId: VenueTradeId | undefined;
  /** Цена исполнения */
  readonly price: DecimalPrice;
  /** Объём */
  readonly size: Quantity;
  /** Сторона агрессора */
  readonly side: Side;
  /** Время площадки из payload — данные, не порядок */
  readonly sourceTimestamp: Timestamp;
}

/** Значение референсной цены в момент наблюдения. */
export interface ReferencePriceObservation extends Observation {
  /** Цена базового актива */
  readonly value: AssetPrice;
  /** Время, которым его пометила площадка */
  readonly venueTimestamp: Timestamp;
  /** Время получения источником, как его сообщил canonical-контур */
  readonly receivedAt: Timestamp;
}

/** Текущий шаг цены инструмента. */
export interface TickSizeState {
  /** Действующий шаг */
  readonly tickSize: DecimalPrice;
  /** Время площадки из payload */
  readonly sourceTimestamp: Timestamp;
  /** Момент наблюдения смены */
  readonly observedAt: Timestamp;
}

/** Ключ инструмента внутри shared-состояния. */
export interface SharedInstrumentKey {
  /** Площадка */
  readonly venueId: string;
  /** Инструмент площадки */
  readonly instrumentId: InstrumentId;
}

/** Идентичность ряда референсных цен. */
export interface ReferencePriceSeriesKey {
  /** Источник данных */
  readonly sourceId: MarketDataSourceId;
  /** Базовый актив */
  readonly baseAsset: string;
  /** Котируемый актив */
  readonly quoteAsset: string;
  /** Вид фида */
  readonly kind: 'SPOT' | 'TWAP';
  /**
   * Окно усреднения TWAP в секундах.
   *
   * @remarks
   * Обязателен для `TWAP` и отсутствует у `SPOT`. TWAP 30 и TWAP 60 —
   * разные ряды, склеивать их нельзя.
   */
  readonly windowSeconds?: number;
}

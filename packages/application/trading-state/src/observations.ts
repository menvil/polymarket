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
import type { AssetSymbolId, MarketDataSourceId, VenueTradeId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/timestamp';
import type { Orderbook } from '@polymarket/orderbook';
import type {
  AssetPrice,
  DecimalPrice,
  OutcomePrice,
  Quantity,
  Side,
} from '@polymarket/value-objects';

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
 * Снимок полного стакана в момент наблюдения.
 *
 * @remarks
 * Единственный источник состояния стакана. Отдельного ряда «верхушки» нет:
 * оба семантических адаптера публикуют `BOOK_DEPTH` на каждое принятое
 * изменение книги, а `BOOK_UPDATED` выводят из ТОГО ЖЕ снимка и только при
 * изменении верхушки. Держать оба ряда значило бы хранить одни и те же
 * данные дважды — верхушка получается из `snapshot` вычислением.
 */
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

/**
 * Текущий шаг цены инструмента.
 *
 * @remarks
 * `OutcomePrice`, а не более широкий `DecimalPrice`: canonical
 * `TICK_SIZE_CHANGED` объявлен market-scoped и несёт именно цену исхода.
 * Расширять тип здесь значило бы ослабить границу, на которую будет
 * опираться execution-слой.
 */
export interface TickSizeState {
  /** Действующий шаг */
  readonly tickSize: OutcomePrice;
  /** Время площадки из payload */
  readonly sourceTimestamp: Timestamp;
  /** Момент наблюдения смены */
  readonly observedAt: Timestamp;
}

/** Общая часть идентичности ряда референсных цен. */
interface ReferencePriceSeriesIdentity {
  /** Источник данных */
  readonly sourceId: MarketDataSourceId;
  /** Базовый актив */
  readonly baseAsset: AssetSymbolId;
  /** Котируемый актив */
  readonly quoteAsset: AssetSymbolId;
}

/**
 * Идентичность ряда референсных цен.
 *
 * @remarks
 * Размеченное объединение, а не «`kind` + необязательное окно»: у TWAP окно
 * усреднения обязано существовать, и тип обязан это гарантировать. Прежняя
 * форма разрешала бессмысленное `{ kind: 'TWAP' }`, а реализация молча
 * подставляла окно `0` — то есть заводила ряд, которого в природе нет.
 *
 * @example
 * ```typescript
 * const spot: ReferencePriceSeriesKey = { sourceId, baseAsset, quoteAsset, kind: 'SPOT' };
 * const twap: ReferencePriceSeriesKey = { sourceId, baseAsset, quoteAsset, kind: 'TWAP', windowSeconds: 30 };
 * // Не компилируется: { sourceId, baseAsset, quoteAsset, kind: 'TWAP' }
 * ```
 */
export type ReferencePriceSeriesKey =
  | (ReferencePriceSeriesIdentity & {
      /** Спотовая цена — окна усреднения нет */
      readonly kind: 'SPOT';
    })
  | (ReferencePriceSeriesIdentity & {
      /** Усреднённая цена */
      readonly kind: 'TWAP';
      /** Окно усреднения в секундах: TWAP 30 и TWAP 60 — разные ряды */
      readonly windowSeconds: number;
    });

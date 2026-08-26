/**
 * Реконструкция стакана Polymarket из authoritative-снапшотов и дельт.
 *
 * @remarks
 * ### Почему это Infrastructure, а не Domain
 *
 * Canonical `Orderbook` (`@polymarket/orderbook`) — ИММУТАБЕЛЬНАЯ сущность:
 * она описывает состояние книги в момент времени и намеренно ничего не знает
 * про delta-протокол конкретного venue. Знание «`price_change` задаёт
 * АБСОЛЮТНЫЙ размер уровня, а `size=0` уровень удаляет» — это протокол
 * Polymarket, то есть infrastructure. Поэтому мутабельное состояние живёт
 * здесь, а наружу отдаётся только новый иммутабельный `Orderbook`.
 *
 * ```text
 * book        ──► REPLACE state ──► Orderbook (новый инстанс)
 * price_change ─► apply deltas  ──► Orderbook (новый инстанс)
 * ```
 *
 * ### Транзакционность применения
 *
 * Любое изменение сначала ВАЛИДИРУЕТСЯ целиком и лишь затем коммитится:
 * один плохой уровень внутри пачки не оставляет книгу наполовину
 * применённой. Это прямое требование к состоянию, из которого выводятся
 * торговые решения.
 *
 * ### Desync и восстановление
 *
 * Дельты Polymarket несут собственные `bestBid`/`bestAsk`. После применения
 * пачки реконструированная верхушка сверяется с ними; расхождение означает,
 * что наша книга разошлась с venue (пропущенное сообщение, реордеринг,
 * дефект протокола). В этом случае инструмент помечается DESYNCED и
 * ПЕРЕСТАЁТ публиковаться — чинить книгу угадыванием запрещено. Единственный
 * выход из desync — следующий authoritative `book`.
 */
import { Orderbook, OrderbookLevel } from '@polymarket/orderbook';
import type { Price, Quantity } from '@polymarket/value-objects';
import { PriceService, QuantityService } from '@polymarket/value-objects';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/timestamp';

/**
 * Сторона книги, к которой относится изменение.
 *
 * @remarks
 * Vendor-семантика Polymarket: `BUY` — заявка на покупку, то есть уровень
 * СТОРОНЫ BID; `SELL` — уровень стороны ASK. Инверсии здесь нет и быть не
 * должно.
 */
export type BookSide = 'BID' | 'ASK';

/** Один уровень входных данных в source-native (строковом) виде. */
export interface RawLevelInput {
  /** Цена уровня — десятичная строка vendor-а (не число!). */
  readonly price: string;
  /** Размер уровня — десятичная строка vendor-а (не число!). */
  readonly size: string;
}

/** Одна дельта: абсолютный размер конкретного уровня конкретной стороны. */
export interface LevelDeltaInput extends RawLevelInput {
  /** Сторона книги (уже отображённая из vendor `BUY`/`SELL`). */
  readonly side: BookSide;
}

/**
 * Лучшие цены, объявленные самим источником вместе с дельтой.
 *
 * @remarks
 * Отсутствующее поле означает «источник не сообщил», а НЕ «стороны нет»:
 * это разные вещи, и проверка desync их различает.
 */
export interface VendorBestPrices {
  /** Лучший bid по мнению источника (десятичная строка) либо `undefined`. */
  readonly bestBid: string | undefined;
  /** Лучший ask по мнению источника (десятичная строка) либо `undefined`. */
  readonly bestAsk: string | undefined;
}

/** Причина, по которой изменение не удалось применить. */
export type ApplyFailureReason =
  /** Дельта пришла раньше первого authoritative `book` по инструменту. */
  | 'NO_SNAPSHOT'
  /** Инструмент помечен DESYNCED — ждём следующий полный `book`. */
  | 'DESYNCED'
  /** Цена/размер не прошли валидацию VO (книга не изменена). */
  | 'INVALID_LEVEL'
  /** Верхушка разошлась с объявленной источником (инструмент ушёл в DESYNC). */
  | 'DESYNC_DETECTED';

/** Результат применения снапшота или пачки дельт. */
export type ApplyOutcome =
  | {
      readonly ok: true;
      /** Новый иммутабельный стакан после применения. */
      readonly book: Orderbook;
      /** Semantic-версия книги инструмента после применения. */
      readonly version: number;
    }
  | {
      readonly ok: false;
      readonly reason: ApplyFailureReason;
      /** Человекочитаемая деталь для structured-лога (без PII/объёмов). */
      readonly detail?: string;
    };

/** Снимок диагностики состояния (для stats адаптера). */
export interface ReconstructionStats {
  /** Сколько инструментов сейчас удерживается в памяти. */
  readonly activeInstruments: number;
  /** Сколько из них сейчас в состоянии DESYNCED. */
  readonly desyncedInstruments: number;
}

/**
 * Состояние книги ОДНОГО инструмента.
 *
 * @remarks
 * Уровни хранятся в `Map` по КАНОНИЧЕСКОМУ строковому ключу цены
 * (`price.value().toString()`), а не по исходной строке источника: иначе
 * `"0.50"` и `"0.5"` стали бы двумя разными уровнями одной цены.
 */
interface InstrumentBook {
  /** Рынок, которому принадлежит инструмент (для cleanup и событий). */
  readonly marketId: MarketId;
  /** Уровни стороны bid: canonical price key → уровень. */
  bids: Map<string, OrderbookLevel>;
  /** Уровни стороны ask: canonical price key → уровень. */
  asks: Map<string, OrderbookLevel>;
  /** Получен ли хотя бы один authoritative `book`. */
  initialized: boolean;
  /** Разошлась ли книга с источником (публикация приостановлена). */
  desynced: boolean;
  /** Монотонная semantic-версия книги инструмента. */
  version: number;
}

/**
 * Мутабельное состояние реконструкции стакана по всем инструментам.
 *
 * @remarks
 * Полное описание модели, транзакционности и политики desync — см. докблок
 * модуля выше.
 *
 * @example
 * ```typescript
 * const state = new OrderbookReconstructionState();
 *
 * state.applySnapshot(instrumentId, marketId, bids, asks, receivedAt, venueTs);
 * const outcome = state.applyDeltas(instrumentId, deltas, best, receivedAt, venueTs);
 * if (outcome.ok) publish(outcome.book);
 * ```
 */
export class OrderbookReconstructionState {
  private readonly _books = new Map<InstrumentId, InstrumentBook>();
  /** Обратный индекс рынок → инструменты (для `forgetMarket`). */
  private readonly _marketIndex = new Map<MarketId, Set<InstrumentId>>();

  /**
   * Полностью ЗАМЕЩАЕТ состояние инструмента authoritative-снапшотом.
   *
   * @param instrumentId - Токен/инструмент, чей стакан пришёл
   * @param marketId - Рынок инструмента (condition_id)
   * @param bids - Уровни bid в source-native виде
   * @param asks - Уровни ask в source-native виде
   * @param receivedAt - Момент получения сообщения (из metadata наблюдения)
   * @param venueTimestamp - Момент, которым venue датировал снапшот
   * @returns `ok: true` с новым `Orderbook` и версией, либо `ok: false` с
   *   причиной `INVALID_LEVEL` (в этом случае прежнее состояние СОХРАНЕНО)
   *
   * @remarks
   * Именно ЗАМЕЩЕНИЕ, а не merge: `book` — полный авторитетный снимок, и
   * уровни, которых в нём нет, обязаны исчезнуть. Это же делает снапшот
   * механизмом восстановления после reconnect/desync — он снимает флаг
   * DESYNCED и возвращает инструмент в публикацию.
   *
   * Транзакционность: сначала парсятся ВСЕ уровни во временные `Map`, и
   * только успех коммитится в состояние.
   *
   * @example
   * ```typescript
   * const outcome = state.applySnapshot(
   *   tokenId, marketId,
   *   [{ price: '0.50', size: '10' }],
   *   [{ price: '0.52', size: '7' }],
   *   receivedAt, venueTimestamp,
   * );
   * ```
   */
  public applySnapshot(
    instrumentId: InstrumentId,
    marketId: MarketId,
    bids: readonly RawLevelInput[],
    asks: readonly RawLevelInput[],
    receivedAt: Timestamp,
    venueTimestamp: Timestamp | undefined,
  ): ApplyOutcome {
    const parsedBids = this._parseLevels(bids);
    if (parsedBids === undefined) {
      return { ok: false, reason: 'INVALID_LEVEL', detail: 'bids' };
    }
    const parsedAsks = this._parseLevels(asks);
    if (parsedAsks === undefined) {
      return { ok: false, reason: 'INVALID_LEVEL', detail: 'asks' };
    }

    // Коммит: полное замещение состояния, DESYNC снимается
    const existing = this._books.get(instrumentId);
    const version = (existing?.version ?? 0) + 1;
    const book: InstrumentBook = {
      marketId,
      bids: parsedBids,
      asks: parsedAsks,
      initialized: true,
      desynced: false,
      version,
    };
    this._books.set(instrumentId, book);
    this._indexMarket(marketId, instrumentId);

    return { ok: true, book: this._toOrderbook(instrumentId, book, receivedAt, venueTimestamp), version };
  }

  /**
   * Применяет пачку дельт ОДНОГО инструмента как единую транзакцию.
   *
   * @param instrumentId - Токен/инструмент, чьи уровни меняются
   * @param deltas - Изменения уровней (абсолютные размеры, НЕ приращения)
   * @param vendorBest - Лучшие цены, объявленные источником (для desync-проверки)
   * @param receivedAt - Момент получения сообщения (из metadata наблюдения)
   * @param venueTimestamp - Момент, которым venue датировал изменение
   * @returns `ok: true` с новым `Orderbook`, либо `ok: false` с причиной
   *
   * @remarks
   * Алгоритм:
   * 1. Инструмент без снапшота → `NO_SNAPSHOT` (частичную книгу НЕ строим:
   *    отсутствие уровня в дельте не означает, что уровня нет на venue).
   * 2. Инструмент в DESYNC → `DESYNCED` (ждём authoritative `book`).
   * 3. Все дельты валидируются и применяются к КОПИЯМ сторон:
   *    `size > 0` — установить/заменить уровень (НЕ прибавить),
   *    `size = 0` — удалить уровень.
   * 4. Верхушка копий сверяется с `vendorBest`; расхождение → инструмент
   *    помечается DESYNCED, копии выбрасываются, книга НЕ публикуется.
   * 5. Только при успехе копии коммитятся и версия увеличивается.
   *
   * @example
   * ```typescript
   * state.applyDeltas(
   *   tokenId,
   *   [{ side: 'BID', price: '0.50', size: '25' }], // 25, а не +25
   *   { bestBid: '0.50', bestAsk: '0.52' },
   *   receivedAt, venueTimestamp,
   * );
   * ```
   */
  public applyDeltas(
    instrumentId: InstrumentId,
    deltas: readonly LevelDeltaInput[],
    vendorBest: VendorBestPrices,
    receivedAt: Timestamp,
    venueTimestamp: Timestamp | undefined,
  ): ApplyOutcome {
    const current = this._books.get(instrumentId);
    if (current === undefined || !current.initialized) {
      return { ok: false, reason: 'NO_SNAPSHOT' };
    }
    if (current.desynced) {
      return { ok: false, reason: 'DESYNCED' };
    }

    // Кандидат состояния: мутируем КОПИИ, оригинал не трогаем до коммита
    const bids = new Map(current.bids);
    const asks = new Map(current.asks);

    for (const delta of deltas) {
      const price = this._parsePrice(delta.price);
      if (price === undefined) {
        return { ok: false, reason: 'INVALID_LEVEL', detail: 'price' };
      }
      const quantity = this._parseQuantity(delta.size);
      if (quantity === undefined) {
        return { ok: false, reason: 'INVALID_LEVEL', detail: 'size' };
      }

      const target = delta.side === 'BID' ? bids : asks;
      const key = price.value().toString();
      if (quantity.isZero()) {
        target.delete(key);
      } else {
        // Абсолютный размер уровня: замена, а не аккумуляция
        target.set(key, OrderbookLevel.create(price, quantity));
      }
    }

    const mismatch = this._detectBestMismatch(bids, asks, vendorBest);
    if (mismatch !== undefined) {
      // Состояние могло разойтись с venue — публиковать его нельзя
      current.desynced = true;
      return { ok: false, reason: 'DESYNC_DETECTED', detail: mismatch };
    }

    // Коммит
    current.bids = bids;
    current.asks = asks;
    current.version += 1;

    return {
      ok: true,
      book: this._toOrderbook(instrumentId, current, receivedAt, venueTimestamp),
      version: current.version,
    };
  }

  /**
   * Известен ли инструмент состоянию (получен ли по нему хоть один `book`).
   *
   * @param instrumentId - Токен/инструмент
   * @returns `true`, если инструмент отслеживается
   */
  public has(instrumentId: InstrumentId): boolean {
    return this._books.has(instrumentId);
  }

  /**
   * Находится ли инструмент в состоянии DESYNCED.
   *
   * @param instrumentId - Токен/инструмент
   * @returns `true`, если публикация приостановлена до следующего `book`
   */
  public isDesynced(instrumentId: InstrumentId): boolean {
    return this._books.get(instrumentId)?.desynced === true;
  }

  /**
   * Semantic-версия книги инструмента.
   *
   * @param instrumentId - Токен/инструмент
   * @returns Текущая версия либо `0`, если инструмент неизвестен
   *
   * @remarks
   * Монотонно возрастает НА КАЖДОЕ успешно применённое semantic-обновление
   * книги ИМЕННО ЭТОГО инструмента. Это не sequence шины: глобальная
   * последовательность содержит сообщения других токенов, RTDS и CEX,
   * поэтому по ней у одного инструмента были бы естественные «дыры»,
   * неотличимые от потерь.
   */
  public versionOf(instrumentId: InstrumentId): number {
    return this._books.get(instrumentId)?.version ?? 0;
  }

  /**
   * Забывает состояние ОДНОГО инструмента.
   *
   * @param instrumentId - Токен/инструмент
   * @returns `true`, если состояние существовало и было удалено
   *
   * @remarks
   * Явная граница памяти: адаптер не знает, когда закончился сбор рынка, и
   * не имеет права это выяснять (иначе он стал бы collection-specific).
   * Владелец жизненного цикла вызывает это сам.
   */
  public forgetInstrument(instrumentId: InstrumentId): boolean {
    const book = this._books.get(instrumentId);
    if (book === undefined) {
      return false;
    }
    this._books.delete(instrumentId);
    const siblings = this._marketIndex.get(book.marketId);
    if (siblings !== undefined) {
      siblings.delete(instrumentId);
      if (siblings.size === 0) {
        this._marketIndex.delete(book.marketId);
      }
    }
    return true;
  }

  /**
   * Забывает состояние ВСЕХ инструментов рынка.
   *
   * @param marketId - Рынок (condition_id)
   * @returns Список забытых инструментов (пустой, если рынок неизвестен)
   *
   * @remarks
   * Возвращается именно СПИСОК, а не счётчик: владелец состояния (адаптер)
   * держит собственные per-instrument проекции и обязан очистить ровно те
   * же ключи. Заводить ради этого второй индекс `market → instruments`
   * значило бы держать два источника истины об одном и том же.
   *
   * @example
   * ```typescript
   * // при закрытии рынка владелец освобождает обе стороны разом
   * state.forgetMarket(marketId); // → [upTokenId, downTokenId]
   * ```
   */
  public forgetMarket(marketId: MarketId): readonly InstrumentId[] {
    const instruments = this._marketIndex.get(marketId);
    if (instruments === undefined) {
      return [];
    }
    const forgotten: InstrumentId[] = [];
    for (const instrumentId of instruments) {
      if (this._books.delete(instrumentId)) {
        forgotten.push(instrumentId);
      }
    }
    this._marketIndex.delete(marketId);
    return forgotten;
  }

  /** Полностью очищает состояние (вызывается при `close()` адаптера). */
  public clear(): void {
    this._books.clear();
    this._marketIndex.clear();
  }

  /**
   * Снимок диагностики состояния.
   *
   * @returns Число отслеживаемых и рассинхронизированных инструментов
   */
  public getStats(): ReconstructionStats {
    let desynced = 0;
    for (const book of this._books.values()) {
      if (book.desynced) desynced++;
    }
    return { activeInstruments: this._books.size, desyncedInstruments: desynced };
  }

  /**
   * Парсит пачку уровней в canonical-представление.
   *
   * @param levels - Уровни в source-native виде
   * @returns `Map` каноничных уровней либо `undefined`, если хоть один
   *   уровень невалиден (тогда вызывающий обязан отбросить ВСЮ пачку)
   *
   * @remarks
   * Уровни с нулевым размером в снапшоте отбрасываются: «уровень с размером
   * 0» и «уровня нет» — одно и то же состояние книги, и хранить первое
   * значило бы держать пустышку, влияющую на глубину.
   */
  private _parseLevels(levels: readonly RawLevelInput[]): Map<string, OrderbookLevel> | undefined {
    const parsed = new Map<string, OrderbookLevel>();
    for (const level of levels) {
      const price = this._parsePrice(level.price);
      if (price === undefined) {
        return undefined;
      }
      const quantity = this._parseQuantity(level.size);
      if (quantity === undefined) {
        return undefined;
      }
      if (quantity.isZero()) {
        continue;
      }
      parsed.set(price.value().toString(), OrderbookLevel.create(price, quantity));
    }
    return parsed;
  }

  /**
   * Парсит цену уровня из десятичной строки источника.
   *
   * @param raw - Десятичная строка vendor-а
   * @returns `Price` VO либо `undefined`, если цена вне домена рынка
   *   предсказаний / не парсится
   *
   * @remarks
   * Строка идёт в `PriceService.create` НАПРЯМУЮ: `Number()`/`parseFloat()`
   * потеряли бы точность ещё до валидации.
   */
  private _parsePrice(raw: string): Price | undefined {
    const result = PriceService.create(raw);
    return result.ok ? result.value : undefined;
  }

  /**
   * Парсит размер уровня из десятичной строки источника.
   *
   * @param raw - Десятичная строка vendor-а
   * @returns `Quantity` VO либо `undefined` при отрицательном/непарсящемся
   *   значении
   */
  private _parseQuantity(raw: string): Quantity | undefined {
    const result = QuantityService.create(raw);
    return result.ok ? result.value : undefined;
  }

  /**
   * Сверяет реконструированную верхушку с объявленной источником.
   *
   * @param bids - Кандидат стороны bid
   * @param asks - Кандидат стороны ask
   * @param vendorBest - Лучшие цены по мнению источника
   * @returns Описание расхождения либо `undefined`, если расхождения нет
   *
   * @remarks
   * Правила сверки:
   * - поле источника отсутствует → он ничего не утверждал, сверки нет;
   * - поле парсится в валидную `Price` → наша верхушка обязана существовать
   *   и быть РАВНОЙ ей;
   * - поле присутствует, но валидной ценой не является (практически это
   *   `"0"` — SDK валидирует формат десятичной строки схемой) → источник
   *   утверждает, что уровней на стороне НЕТ, и наша сторона обязана быть
   *   пустой.
   *
   * Сравнение идёт по `Price.equals` (Decimal), а не по строкам: `"0.50"` и
   * `"0.5"` — одна и та же цена.
   */
  private _detectBestMismatch(
    bids: Map<string, OrderbookLevel>,
    asks: Map<string, OrderbookLevel>,
    vendorBest: VendorBestPrices,
  ): string | undefined {
    const bidMismatch = this._sideMismatch('bid', bids, vendorBest.bestBid, (a, b) =>
      a.value().greaterThan(b.value()),
    );
    if (bidMismatch !== undefined) return bidMismatch;

    return this._sideMismatch('ask', asks, vendorBest.bestAsk, (a, b) =>
      a.value().lessThan(b.value()),
    );
  }

  /**
   * Сверяет одну сторону книги с объявленной источником лучшей ценой.
   *
   * @param side - Имя стороны для сообщения о расхождении
   * @param levels - Кандидат уровней стороны
   * @param vendorBest - Лучшая цена стороны по мнению источника
   * @param isBetter - Предикат «первая цена лучше второй» для этой стороны
   * @returns Описание расхождения либо `undefined`
   */
  private _sideMismatch(
    side: 'bid' | 'ask',
    levels: Map<string, OrderbookLevel>,
    vendorBest: string | undefined,
    isBetter: (a: Price, b: Price) => boolean,
  ): string | undefined {
    if (vendorBest === undefined) {
      return undefined;
    }
    const ours = this._bestOf(levels, isBetter);
    const claimed = this._parsePrice(vendorBest);

    if (claimed === undefined) {
      // Источник утверждает «уровней нет»
      return ours === undefined ? undefined : `${side}: source reports empty side, reconstructed ${ours.value().toString()}`;
    }
    if (ours === undefined) {
      return `${side}: source reports ${claimed.value().toString()}, reconstructed side is empty`;
    }
    return ours.equals(claimed)
      ? undefined
      : `${side}: source reports ${claimed.value().toString()}, reconstructed ${ours.value().toString()}`;
  }

  /**
   * Находит лучшую цену стороны.
   *
   * @param levels - Уровни стороны
   * @param isBetter - Предикат «первая цена лучше второй»
   * @returns Лучшая цена либо `undefined`, если сторона пуста
   */
  private _bestOf(
    levels: Map<string, OrderbookLevel>,
    isBetter: (a: Price, b: Price) => boolean,
  ): Price | undefined {
    let best: Price | undefined;
    for (const level of levels.values()) {
      if (best === undefined || isBetter(level.price, best)) {
        best = level.price;
      }
    }
    return best;
  }

  /**
   * Строит новый иммутабельный `Orderbook` из текущего состояния.
   *
   * @param instrumentId - Токен/инструмент
   * @param book - Внутреннее состояние инструмента
   * @param receivedAt - Момент получения наблюдения
   * @param venueTimestamp - Момент venue
   * @returns Новый `Orderbook`
   *
   * @remarks
   * Массивы уровней собираются ЗАНОВО на каждый вызов — наружу никогда не
   * утекают внутренние `Map`, и потребитель не может изменить состояние
   * реконструкции.
   *
   * `Orderbook.fromLevels` сортирует стороны сам; первым аргументом сущность
   * ожидает marketId (унаследованный неймингный артефакт `Orderbook`:
   * поле называется `instrumentId`, но по контракту `fromNormalized` несёт
   * marketId), вторым — токен.
   */
  private _toOrderbook(
    instrumentId: InstrumentId,
    book: InstrumentBook,
    receivedAt: Timestamp,
    venueTimestamp: Timestamp | undefined,
  ): Orderbook {
    return Orderbook.fromLevels(
      book.marketId as unknown as InstrumentId,
      instrumentId,
      [...book.bids.values()],
      [...book.asks.values()],
      receivedAt,
      venueTimestamp,
    );
  }

  /**
   * Добавляет инструмент в обратный индекс рынка.
   *
   * @param marketId - Рынок инструмента
   * @param instrumentId - Токен/инструмент
   */
  private _indexMarket(marketId: MarketId, instrumentId: InstrumentId): void {
    let siblings = this._marketIndex.get(marketId);
    if (siblings === undefined) {
      siblings = new Set<InstrumentId>();
      this._marketIndex.set(marketId, siblings);
    }
    siblings.add(instrumentId);
  }
}

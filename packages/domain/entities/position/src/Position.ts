/**
 * Сущность Position (Позиция)
 *
 * @remarks
 * Представляет открытую/закрытую позицию по активу.
 * Position является неизменяемой доменной сущностью (immutable entity).
 *
 * ### Архитектура (DDD):
 * - **Единственный источник истины**: `lots[]` — все остальные поля вычислены
 * - **quantity** = sum(lot.quantity) — derived getter
 * - **averageEntryPrice** = weighted average по лотам — derived getter
 * - **openedQuantity** — хранимое поле, не меняется при close() (исходный размер)
 * - **openedAt** — timestamp первого открытия, неизменён
 * - **updatedAt** — обновляется при close() и addLots()
 * - **Мутация**: `close()` → `computeClose()` → `applyClose()` → новый экземпляр
 * - **Рост позиции**: `addLots()` → merge + sort → новый экземпляр с увеличенным openedQuantity
 *
 * ### Dependency graph (без циклов):
 * ```
 * PositionLot.ts  → value-objects
 * lot-closing.ts  → PositionLot.ts, value-objects     (нет Position!)
 * Position.ts     → PositionLot.ts, lot-closing.ts
 * fifo-lifo.ts    → Position.ts                       (thin wrapper)
 * ```
 *
 * ### Жизненный цикл:
 * ```
 * OPEN → PARTIALLY_CLOSED → CLOSED
 * ```
 *
 * ### Определение статуса через lots и openedQuantity:
 * - `lots.length === 0` → CLOSED (нет лотов)
 * - `quantity < openedQuantity` → PARTIALLY_CLOSED (были закрытия)
 * - `quantity === openedQuantity` → OPEN (закрытий не было)
 *
 * ### Оптимизация сортировки:
 * Лоты сортируются только в create() и addLots() — O(n log n) один раз.
 * applyClose() получает уже отсортированные remainingLots:
 * - FIFO: remainingLots от computeClose уже в ASC-порядке
 * - LIFO: remainingLots от computeClose в DESC → close() делает reverse() → ASC
 * Конструктор не сортирует — он доверяет вызывающей стороне.
 *
 * @remarks
 * Почему не realizedPnL для PARTIALLY_CLOSED?
 * При закрытии по цене входа (closePrice == entryPrice) realizedPnL = 0,
 * но позиция всё равно частично закрыта. openedQuantity — корректный индикатор.
 *
 * @remarks
 * Почему fees убраны из Position?
 * Комиссии принадлежат Fill (исполнению ордера), а не Position.
 * Позиция отражает рыночный риск; комиссии — это операционные расходы
 * на уровне Fill/Ledger, а не позиции.
 *
 * @example
 * ```typescript
 * import { Position, PositionLot } from './Position';
 * import { Quantity, Price, Timestamp } from '@polymarket/value-objects';
 *
 * const lot = PositionLot.create({
 *   quantity: Quantity.of(new Decimal(100)),
 *   entryPrice: Price.of(new Decimal(0.65)),
 *   timestamp: Timestamp.of(new Decimal(1705318200000)),
 * });
 *
 * const now = Timestamp.now();
 * const result = Position.create({
 *   id: asPositionId('pos-123')!,
 *   accountId: parseAccountId('venue:POLYMARKET:account-456')!,
 *   instrumentId: asInstrumentId('market-abc-token-yes')!,
 *   asset: AssetIdHelpers.USDC,
 *   side: 'LONG',
 *   openedAt: now,
 *   lots: [lot],
 * });
 *
 * if (result.ok) {
 *   const position = result.value;
 *   const closeResult = position.close(
 *     Quantity.of(new Decimal(50)),
 *     Price.of(new Decimal(0.75)),
 *     'FIFO',
 *     Timestamp.now(),
 *   );
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import { SignedQuantity } from '@polymarket/value-objects/signed-quantity';
import { ValidationError } from '@polymarket/errors';
import type { PositionId, AccountId, InstrumentId, AssetId } from '@polymarket/ids';
import Decimal from 'decimal.js';
import { PositionLot } from './core/PositionLot.js';
import {
  computeClose,
  calculateWeightedAveragePrice,
  type LotCloseComputation,
  type ClosedLotInfo,
} from './algorithms/lot-closing.js';

/**
 * Сторона позиции
 *
 * @remarks
 * - LONG — длинная позиция (покупка)
 * - SHORT — короткая позиция (продажа)
 */
export type PositionSide = 'LONG' | 'SHORT';

/**
 * Статус позиции
 *
 * @remarks
 * - OPEN — позиция открыта полностью (закрытий не было)
 * - PARTIALLY_CLOSED — частично закрыта (quantity < openedQuantity)
 * - CLOSED — полностью закрыта (lots.length === 0)
 */
export type PositionStatus = 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED';

/**
 * Результат закрытия позиции
 *
 * @remarks
 * Содержит новую позицию после закрытия и реализованный P&L.
 * Определён в Position.ts чтобы избежать циклических зависимостей.
 */
export interface CloseResult {
  readonly position: Position;
  readonly realizedPnL: SignedQuantity;
  readonly closedLots: readonly ClosedLotInfo[];
}

/**
 * Параметры создания Position
 *
 * @remarks
 * - `quantity` и `averageEntryPrice` исключены — вычисляются из `lots`
 * - `openedQuantity` — исходный размер позиции, сохраняется неизменным через все close()
 *   Если не передан — устанавливается равным текущему quantity при создании
 * - `openedAt` — timestamp первого открытия (неизменён)
 * - `updatedAt` — timestamp последней операции (defaults to openedAt)
 * - `fees` убраны — комиссии принадлежат Fill, не Position
 */
export interface PositionParams {
  readonly id: PositionId;
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  readonly asset: AssetId;
  readonly side: PositionSide;
  readonly openedAt: Timestamp;
  readonly updatedAt?: Timestamp;
  readonly lots: readonly PositionLot[];
  readonly openedQuantity?: Quantity;
  readonly realizedPnL?: SignedQuantity;
}

/**
 * Класс Position — неизменяемая доменная сущность
 *
 * @remarks
 * - `lots[]` — единственный источник истины
 * - `quantity` и `averageEntryPrice` — вычисляемые getters
 * - `openedQuantity` — хранимое поле, не изменяется при close()
 * - `openedAt` — неизменяемый timestamp открытия
 * - `updatedAt` — обновляется при каждом close() и addLots()
 * - Конструктор НЕ сортирует лоты — только create() и addLots() сортируют
 * - `close()` возвращает новый экземпляр через `applyClose()`
 *
 * ### Инварианты:
 * - Все лоты в `lots` имеют quantity > 0 (проверяется в create() и addLots())
 * - `lots` всегда отсортированы по timestamp ASC (гарантируют create() и addLots())
 * - `openedQuantity >= quantity` (исходный размер >= текущий)
 * - `updatedAt >= openedAt` (последнее обновление не раньше открытия)
 */
export class Position {
  public readonly id: PositionId;
  public readonly accountId: AccountId;
  public readonly instrumentId: InstrumentId;
  public readonly asset: AssetId;
  public readonly side: PositionSide;
  /** Timestamp первого открытия позиции — неизменён */
  public readonly openedAt: Timestamp;
  /** Timestamp последней операции (close/addLots) — defaults to openedAt */
  public readonly updatedAt: Timestamp;
  public readonly lots: readonly PositionLot[];
  /**
   * Исходный суммарный объём позиции.
   *
   * @remarks
   * Сохраняется неизменным через все close()-вызовы для корректного
   * определения статуса PARTIALLY_CLOSED.
   * Увеличивается при addLots() (рост позиции).
   * При создании позиции с нуля = текущему quantity.
   */
  public readonly openedQuantity: Quantity;
  public readonly realizedPnL: SignedQuantity;

  /**
   * Derived getter: суммарный объём позиции из лотов
   *
   * @returns Quantity.ZERO если лотов нет
   *
   * @remarks
   * Вычисляется как sum(lot.quantity) по всем лотам.
   * Изменяется автоматически при создании нового экземпляра после close().
   *
   * @example
   * ```typescript
   * console.log(position.quantity.value().toNumber()); // 100
   * ```
   */
  public get quantity(): Quantity {
    if (this.lots.length === 0) {
      return Quantity.ZERO;
    }
    const total = this.lots.reduce(
      (sum, lot) => sum.plus(lot.quantity.value()),
      new Decimal(0)
    );
    return Quantity.of(total);
  }

  /**
   * Derived getter: средневзвешенная цена входа по лотам
   *
   * @returns Price.MIN если лотов нет
   *
   * @remarks
   * Формула: sum(lot.price * lot.qty) / sum(lot.qty)
   *
   * @example
   * ```typescript
   * // Два лота: 50@0.60 + 50@0.70 → average = 0.65
   * console.log(position.averageEntryPrice.value().toNumber()); // 0.65
   * ```
   */
  public get averageEntryPrice(): Price {
    return calculateWeightedAveragePrice(this.lots);
  }

  /**
   * Приватный конструктор — используйте Position.create()
   *
   * @param params - Параметры позиции
   *
   * @remarks
   * ### Гарантии конструктора:
   * - Доверяет caller'у что lots уже отсортированы (create() и addLots() гарантируют это)
   * - `openedQuantity` устанавливается равным текущему quantity если не передан
   * - `updatedAt` defaults to `openedAt` если не передан
   *
   * ### Почему нет сортировки в конструкторе?
   * Оптимизация: sort O(n log n) нужен только при внешней мутации (create, addLots).
   * applyClose() уже знает порядок remainingLots и передаёт их отсортированными.
   * Конструктор вызывается при каждом close() — избегаем лишний O(n log n).
   */
  private constructor(params: PositionParams) {
    this.id = params.id;
    this.accountId = params.accountId;
    this.instrumentId = params.instrumentId;
    this.asset = params.asset;
    this.side = params.side;
    this.openedAt = params.openedAt;
    this.updatedAt = params.updatedAt ?? params.openedAt;
    // Caller гарантирует отсортированный порядок
    this.lots = params.lots as readonly PositionLot[];
    this.realizedPnL = params.realizedPnL ?? SignedQuantity.ZERO;
    // openedQuantity: если не передан — текущий quantity (первое открытие)
    // Примечание: this.lots уже присвоен выше, поэтому this.quantity работает корректно
    this.openedQuantity = params.openedQuantity ?? this.quantity;
  }

  /**
   * Создаёт Position с валидацией обязательных полей и инвариантов лотов
   *
   * @param params - Параметры позиции
   * @returns Result<Position, ValidationError>
   *
   * @remarks
   * ### Валидации:
   * - Обязательные identity-поля: id, accountId, instrumentId, asset, openedAt
   * - Инварианты лотов: все лоты должны иметь quantity > 0
   *
   * ### Сортировка:
   * Лоты сортируются по timestamp ASC перед созданием — единственная точка сортировки
   * при внешнем создании. applyClose() передаёт уже отсортированные лоты напрямую.
   *
   * quantity и averageEntryPrice не требуют валидации — они вычислены из lots.
   *
   * @throws Не бросает — возвращает Result
   *
   * @example
   * ```typescript
   * const result = Position.create({
   *   id: asPositionId('pos-1')!,
   *   accountId: parseAccountId('venue:POLYMARKET:acc-1')!,
   *   instrumentId: asInstrumentId('token-yes')!,
   *   asset: AssetIdHelpers.USDC,
   *   side: 'LONG',
   *   openedAt: Timestamp.now(),
   *   lots: [lot],
   * });
   * ```
   */
  public static create(params: PositionParams): Result<Position, ValidationError> {
    if (!params.id) {
      return Err(new ValidationError('Position ID is required', { context: { field: 'id' } }));
    }

    if (!params.accountId) {
      return Err(
        new ValidationError('Account ID is required', {
          context: { field: 'accountId', positionId: params.id },
        })
      );
    }

    if (!params.instrumentId) {
      return Err(
        new ValidationError('Instrument ID is required', {
          context: { field: 'instrumentId', positionId: params.id },
        })
      );
    }

    if (!params.asset) {
      return Err(
        new ValidationError('Asset ID is required', {
          context: { field: 'asset', positionId: params.id },
        })
      );
    }

    if (!params.openedAt) {
      return Err(
        new ValidationError('openedAt is required', {
          context: { field: 'openedAt', positionId: params.id },
        })
      );
    }

    // Инвариант лотов: нет пустых лотов (quantity = 0)
    // Пустой лот — признак бага в коде вызывающей стороны.
    // computeClose никогда не производит пустые лоты, поэтому
    // этот check защищает только внешние create()-вызовы.
    const emptyLot = params.lots.find(lot => lot.quantity.isZero());
    if (emptyLot) {
      return Err(
        new ValidationError('Lots must not contain empty lots (zero quantity)', {
          context: { field: 'lots', positionId: params.id },
        })
      );
    }

    // Сортируем лоты один раз при создании — O(n log n) только здесь
    const sortedLots = [...params.lots].sort(
      (a, b) => a.timestamp.toNumber() - b.timestamp.toNumber()
    );

    return Ok(new Position({ ...params, lots: sortedLots }));
  }

  /**
   * Закрывает позицию используя FIFO или LIFO стратегию
   *
   * @param closeQuantity - Количество для закрытия
   * @param closePrice - Цена закрытия
   * @param strategy - 'FIFO' (старые лоты первые) или 'LIFO' (новые первые)
   * @param closedAt - Timestamp операции закрытия (записывается в updatedAt)
   * @returns Result<CloseResult, ValidationError>
   *
   * @remarks
   * ### Алгоритм:
   * 1. FIFO: `orderedLots = this.lots` (уже отсортированы ASC)
   * 2. LIFO: `orderedLots = [...this.lots].reverse()` (DESC)
   * 3. `computeClose(orderedLots, side, qty, price)` — pure computation без Position
   * 4. Определяем порядок remainingLots:
   *    - FIFO: remainingLots уже в ASC → передаём as-is
   *    - LIFO: remainingLots в DESC → reverse() → ASC
   * 5. `applyClose(computation, sortedRemaining, closedAt)` — Entity создаёт новый экземпляр
   *
   * ### Оптимизация сортировки:
   * Конструктор не сортирует лоты. close() передаёт уже отсортированные remainingLots,
   * что позволяет избежать O(n log n) при каждом закрытии.
   *
   * @throws Не бросает — возвращает Result
   *
   * @example
   * ```typescript
   * const result = position.close(
   *   Quantity.of(new Decimal(50)),
   *   Price.of(new Decimal(0.75)),
   *   'FIFO',
   *   Timestamp.now(),
   * );
   * if (result.ok) {
   *   const { position: newPosition, realizedPnL } = result.value;
   *   // newPosition.getStatus() === 'PARTIALLY_CLOSED' или 'CLOSED'
   *   // newPosition.updatedAt === closedAt
   * }
   * ```
   */
  public close(
    closeQuantity: Quantity,
    closePrice: Price,
    strategy: 'FIFO' | 'LIFO',
    closedAt: Timestamp,
  ): Result<CloseResult, ValidationError> {
    const orderedLots =
      strategy === 'FIFO' ? this.lots : [...this.lots].reverse();

    const computationResult = computeClose(orderedLots, this.side, closeQuantity, closePrice);
    if (!computationResult.ok) {
      return computationResult;
    }

    // FIFO: computeClose итерирует ASC → remainingLots в ASC-порядке
    // LIFO: computeClose итерирует DESC → remainingLots в DESC-порядке → обращаем
    const sortedRemaining =
      strategy === 'FIFO'
        ? computationResult.value.remainingLots
        : [...computationResult.value.remainingLots].reverse();

    const newPosition = this.applyClose(computationResult.value, sortedRemaining, closedAt);
    return Ok({
      position: newPosition,
      realizedPnL: SignedQuantity.of(computationResult.value.totalRealizedPnL),
      closedLots: computationResult.value.closedLots,
    });
  }

  /**
   * Добавляет новые лоты к позиции (рост позиции)
   *
   * @param newLots - Новые лоты для добавления
   * @param addedAt - Timestamp операции добавления (записывается в updatedAt)
   * @returns Result<Position, ValidationError>
   *
   * @remarks
   * ### Алгоритм:
   * 1. Валидация: newLots не пустой, нет лотов с quantity = 0
   * 2. Merge: [...this.lots, ...newLots].sort(ASC)
   * 3. openedQuantity += sum(newLots.quantity) (рост исходного размера)
   * 4. updatedAt = addedAt
   *
   * ### Инварианты:
   * - openedQuantity всегда растёт при addLots()
   * - После addLots() lots отсортированы по timestamp ASC
   *
   * @throws Не бросает — возвращает Result
   *
   * @example
   * ```typescript
   * const moreLots = [newLot1, newLot2];
   * const result = position.addLots(moreLots, Timestamp.now());
   * if (result.ok) {
   *   const grown = result.value;
   *   // grown.openedQuantity > position.openedQuantity
   *   // grown.quantity > position.quantity
   * }
   * ```
   */
  public addLots(
    newLots: readonly PositionLot[],
    addedAt: Timestamp,
  ): Result<Position, ValidationError> {
    if (newLots.length === 0) {
      return Err(
        new ValidationError('New lots must not be empty', {
          context: { field: 'newLots', positionId: this.id },
        })
      );
    }

    const emptyLot = newLots.find(lot => lot.quantity.isZero());
    if (emptyLot) {
      return Err(
        new ValidationError('New lots must not contain empty lots (zero quantity)', {
          context: { field: 'newLots', positionId: this.id },
        })
      );
    }

    // Объединяем и сортируем лоты — O(n log n), но только при явном росте позиции
    const mergedLots = [...this.lots, ...newLots].sort(
      (a, b) => a.timestamp.toNumber() - b.timestamp.toNumber()
    );

    // openedQuantity растёт на сумму новых лотов
    const addedQty = newLots.reduce(
      (sum, lot) => sum.plus(lot.quantity.value()),
      new Decimal(0)
    );
    const newOpenedQuantity = Quantity.of(this.openedQuantity.value().plus(addedQty));

    return Ok(
      new Position({
        id: this.id,
        accountId: this.accountId,
        instrumentId: this.instrumentId,
        asset: this.asset,
        side: this.side,
        openedAt: this.openedAt,
        updatedAt: addedAt,
        lots: mergedLots,
        openedQuantity: newOpenedQuantity,
        realizedPnL: this.realizedPnL,
      })
    );
  }

  /**
   * Применяет результат вычисления закрытия — создаёт новый экземпляр Position
   *
   * @param computation - Результат computeClose()
   * @param sortedRemaining - Остаточные лоты в ASC-порядке (подготовлены caller'ом)
   * @param closedAt - Timestamp операции закрытия
   * @returns Новый Position с обновлёнными лотами и накопленным realizedPnL
   *
   * @remarks
   * - Накапливает realizedPnL: newPnL = this.realizedPnL + computation.totalRealizedPnL
   * - Сохраняет `openedQuantity` неизменным (исходный размер позиции)
   * - Принимает уже отсортированные sortedRemaining — конструктор не сортирует
   * - updatedAt = closedAt (аудит-след операции закрытия)
   *
   * @internal
   */
  private applyClose(
    computation: LotCloseComputation,
    sortedRemaining: readonly PositionLot[],
    closedAt: Timestamp,
  ): Position {
    const newRealizedPnL = this.realizedPnL.value().plus(computation.totalRealizedPnL);
    return new Position({
      id: this.id,
      accountId: this.accountId,
      instrumentId: this.instrumentId,
      asset: this.asset,
      side: this.side,
      openedAt: this.openedAt,
      updatedAt: closedAt,
      lots: sortedRemaining,
      openedQuantity: this.openedQuantity, // сохраняем исходный размер
      realizedPnL: SignedQuantity.of(newRealizedPnL),
    });
  }

  /**
   * Возвращает статус позиции на основе lots и openedQuantity
   *
   * @returns PositionStatus
   *
   * @remarks
   * ### Логика:
   * - `lots.length === 0` → CLOSED (все лоты исчерпаны)
   * - `quantity < openedQuantity` → PARTIALLY_CLOSED (были закрытия)
   * - `quantity === openedQuantity` → OPEN (закрытий не было)
   *
   * ### Почему не realizedPnL для PARTIALLY_CLOSED?
   * При закрытии по цене входа: `closePrice == entryPrice` → `realizedPnL = 0`,
   * но позиция всё равно частично закрыта.
   * Правильный индикатор — `openedQuantity > quantity`.
   *
   * @example
   * ```typescript
   * // Lot: 100@0.60, close 50@0.60 → realizedPnL=0, status='PARTIALLY_CLOSED' ✓
   * console.log(position.getStatus()); // 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED'
   * ```
   */
  public getStatus(): PositionStatus {
    if (this.lots.length === 0) {
      return 'CLOSED';
    }
    if (this.quantity.value().lt(this.openedQuantity.value())) {
      return 'PARTIALLY_CLOSED';
    }
    return 'OPEN';
  }

  /**
   * Проверяет открыта ли позиция (есть активные лоты)
   *
   * @returns true если есть хотя бы один лот
   */
  public isOpen(): boolean {
    return this.lots.length > 0;
  }

  /**
   * Проверяет закрыта ли позиция (нет лотов)
   *
   * @returns true если lots пустой
   */
  public isClosed(): boolean {
    return this.lots.length === 0;
  }

  /**
   * Вычисляет unrealized P&L по текущей рыночной цене
   *
   * @param currentPrice - Текущая рыночная цена
   * @returns Unrealized P&L как SignedQuantity (ZERO для закрытой позиции)
   *
   * @remarks
   * - LONG: `(currentPrice - averageEntryPrice) * quantity`
   * - SHORT: `-(currentPrice - averageEntryPrice) * quantity`
   *
   * @example
   * ```typescript
   * const pnl = position.getUnrealizedPnL(Price.of(new Decimal(0.75)));
   * // 100 * (0.75 - 0.65) = 10
   * ```
   */
  public getUnrealizedPnL(currentPrice: Price): SignedQuantity {
    if (this.quantity.isZero()) {
      return SignedQuantity.ZERO;
    }

    const priceDiff = currentPrice.value().minus(this.averageEntryPrice.value());
    const pnl = priceDiff.times(this.quantity.value());

    return SignedQuantity.of(this.side === 'LONG' ? pnl : pnl.negated());
  }

  /**
   * Возвращает total P&L (realized + unrealized)
   *
   * @param currentPrice - Текущая рыночная цена
   * @returns Total P&L как SignedQuantity
   *
   * @example
   * ```typescript
   * const total = position.getTotalPnL(Price.of(new Decimal(0.75)));
   * // 15 realized + 10 unrealized = 25
   * ```
   */
  public getTotalPnL(currentPrice: Price): SignedQuantity {
    const unrealized = this.getUnrealizedPnL(currentPrice);
    const total = this.realizedPnL.value().plus(unrealized.value());
    return SignedQuantity.of(total);
  }

  /**
   * Преобразует Position в plain object
   *
   * @returns Record с string для Decimal-полей (сохранение точности)
   *
   * @remarks
   * Decimal-поля (quantity, openedQuantity, averageEntryPrice, realizedPnL) → string.
   * openedAt/updatedAt → number (epoch ms).
   *
   * @example
   * ```typescript
   * const json = position.toJSON();
   * console.log(json.quantity);       // '100' (string)
   * console.log(json.openedQuantity); // '100' (string)
   * console.log(json.openedAt);       // 1705318200000 (number)
   * ```
   */
  public toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      accountId: this.accountId,
      instrumentId: this.instrumentId,
      asset: this.asset,
      side: this.side,
      quantity: this.quantity.value().toString(),
      openedQuantity: this.openedQuantity.value().toString(),
      averageEntryPrice: this.averageEntryPrice.value().toString(),
      openedAt: this.openedAt.toNumber(),
      updatedAt: this.updatedAt.toNumber(),
      status: this.getStatus(),
      realizedPnL: this.realizedPnL.value().toString(),
      lotsCount: this.lots.length,
    };
  }

  /**
   * Строковое представление для логирования
   *
   * @returns Человекочитаемое описание позиции
   *
   * @example
   * ```typescript
   * console.log(position.toString());
   * // "Position[pos-123]: LONG 100/100 @ 0.65 (OPEN)"
   * //                           ↑ qty/openedQty
   * ```
   */
  public toString(): string {
    return `Position[${this.id}]: ${this.side} ${this.quantity.value().toNumber()}/${this.openedQuantity.value().toNumber()} @ ${this.averageEntryPrice.value().toNumber()} (${this.getStatus()})`;
  }
}

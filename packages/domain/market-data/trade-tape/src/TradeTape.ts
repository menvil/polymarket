/**
 * Лента трейдов (Trade Tape)
 *
 * @remarks
 * Append-only хранилище трейдов для конкретного рынка и токена.
 * Используется для накопления истории рыночных принтов и последующего анализа.
 *
 * ### Дизайн:
 * - Append-only: трейды только добавляются, не изменяются
 * - Фильтрация по marketId+tokenId: несовпадающие трейды логируются и отклоняются
 * - evictBefore(): очистка устаревших данных для управления памятью
 * - getWindow() / getRecent(): гибкая выборка по временным окнам
 *
 * ### Почему не Map<Timestamp, Trade>:
 * Несколько трейдов могут иметь одинаковый timestamp (в рамках одной миллисекунды).
 * Поэтому используем простой массив с сортировкой по времени при необходимости.
 *
 * ### Bounded context:
 * TradeTape — это market-data, не accounting.
 * Не знает о Fill, Order, Portfolio.
 * Данные для аналитики и построения сигналов.
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import type { AssetId, MarketId } from '@polymarket/ids';
import { asMarketId, assetIdToString } from '@polymarket/ids';
import type { Trade } from '@polymarket/trade';

/**
 * Лента трейдов для конкретного рынка и токена
 *
 * @remarks
 * Создаётся через TradeTape.create() с валидацией.
 * Все добавляемые трейды должны принадлежать тому же marketId+tokenId.
 *
 * @example
 * ```typescript
 * import { TradeTape } from '@polymarket/trade-tape';
 * import { parseAssetId } from '@polymarket/ids';
 *
 * const tokenId = parseAssetId('token-yes-abc')!;
 * const result = TradeTape.create('market-abc', tokenId);
 * if (result.ok) {
 *   const tape = result.value;
 *   tape.append(trade);
 *
 *   const recent = tape.getRecent(60_000); // последняя минута
 *   const metrics = TradeFlowCalculator.compute(recent);
 * }
 * ```
 */
export class TradeTape {
  public readonly marketId: MarketId;
  public readonly tokenId: AssetId;

  private readonly _tokenIdStr: string;
  private readonly _trades: Trade[];

  /**
   * Приватный конструктор — используйте TradeTape.create()
   */
  private constructor(marketId: MarketId, tokenId: AssetId) {
    this.marketId = marketId;
    this.tokenId = tokenId;
    this._tokenIdStr = assetIdToString(tokenId);
    this._trades = [];
  }

  /**
   * Создаёт новую ленту трейдов с валидацией
   *
   * @param marketId - ID рынка (непустая строка)
   * @param tokenId - ID токена (AssetId)
   * @returns Result<TradeTape, ValidationError>
   *
   * @throws Никогда — ошибки возвращаются через Result
   *
   * @example
   * ```typescript
   * const result = TradeTape.create('market-abc', tokenId);
   * if (result.ok) {
   *   const tape = result.value;
   * }
   * ```
   */
  public static create(
    marketId: string,
    tokenId: AssetId
  ): Result<TradeTape, ValidationError> {
    const validMarketId = asMarketId(marketId);
    if (!validMarketId) {
      return Err(
        new ValidationError('Market ID is required and must be non-empty', {
          context: { field: 'marketId', value: marketId },
        })
      );
    }

    if (!tokenId) {
      return Err(
        new ValidationError('Token ID is required', {
          context: { field: 'tokenId' },
        })
      );
    }

    return Ok(new TradeTape(validMarketId, tokenId));
  }

  /**
   * Добавляет трейд в ленту
   *
   * @param trade - Трейд для добавления
   *
   * @throws {Error} Если marketId или tokenId трейда не совпадают с лентой
   *
   * @remarks
   * Несовпадение marketId или tokenId — это ошибка программиста:
   * вызывающий код обязан передавать трейды только для нужного инструмента.
   *
   * @example
   * ```typescript
   * tape.append(trade); // бросит Error если marketId/tokenId не совпадают
   * ```
   */
  public append(trade: Trade): void {
    if (trade.marketId !== this.marketId) {
      throw new Error(
        `TradeTape[${this.marketId}/${this._tokenIdStr}]: trade marketId mismatch: expected=${this.marketId}, got=${trade.marketId}`
      );
    }

    if (assetIdToString(trade.tokenId) !== this._tokenIdStr) {
      throw new Error(
        `TradeTape[${this.marketId}/${this._tokenIdStr}]: trade tokenId mismatch: expected=${this._tokenIdStr}, got=${assetIdToString(trade.tokenId)}`
      );
    }

    this._trades.push(trade);
  }

  /**
   * Возвращает все трейды в ленте
   *
   * @returns Readonly массив всех трейдов
   */
  public getAll(): readonly Trade[] {
    return this._trades;
  }

  /**
   * Возвращает трейды в заданном временном окне
   *
   * @param fromMs - Начало окна (включительно) в миллисекундах
   * @param toMs - Конец окна (включительно) в миллисекундах
   * @returns Отфильтрованные трейды
   *
   * @example
   * ```typescript
   * const window = tape.getWindow(
   *   Date.now() - 300_000, // 5 минут назад
   *   Date.now()
   * );
   * ```
   */
  public getWindow(fromMs: number, toMs: number): readonly Trade[] {
    return this._trades.filter((trade) => {
      const ms = trade.timestamp.toNumber();
      return ms >= fromMs && ms <= toMs;
    });
  }

  /**
   * Возвращает трейды за последние N миллисекунд
   *
   * @param durationMs - Длительность окна в миллисекундах
   * @param nowMs - Текущее время (по умолчанию Date.now())
   * @returns Трейды в заданном временном окне
   *
   * @remarks
   * nowMs позволяет тестировать метод без зависимости от системного времени.
   *
   * @example
   * ```typescript
   * const lastMinute = tape.getRecent(60_000);
   * const last5Min = tape.getRecent(300_000, fixedNow);
   * ```
   */
  public getRecent(durationMs: number, nowMs?: number): readonly Trade[] {
    const now = nowMs ?? Date.now();
    return this.getWindow(now - durationMs, now);
  }

  /**
   * Удаляет трейды старше заданного момента времени
   *
   * @param cutoffMs - Граница отсечения в миллисекундах (исключительно)
   * @returns Количество удалённых трейдов
   *
   * @remarks
   * Используется для управления памятью: удаляет устаревшие данные
   * которые больше не нужны для анализа.
   *
   * @example
   * ```typescript
   * // Удалить трейды старше 1 часа
   * const evicted = tape.evictBefore(Date.now() - 3600_000);
   * console.log(`Evicted ${evicted} old trades`);
   * ```
   */
  public evictBefore(cutoffMs: number): number {
    const before = this._trades.length;

    // Находим первый индекс, где timestamp >= cutoffMs
    let splitIndex = 0;
    for (let i = 0; i < this._trades.length; i++) {
      if (this._trades[i]!.timestamp.toNumber() >= cutoffMs) {
        splitIndex = i;
        break;
      }
      splitIndex = i + 1;
    }

    this._trades.splice(0, splitIndex);
    return before - this._trades.length;
  }

  /**
   * Возвращает количество трейдов в ленте
   *
   * @returns Количество трейдов
   */
  public size(): number {
    return this._trades.length;
  }

  /**
   * Проверяет, пустая ли лента
   *
   * @returns True если нет трейдов
   */
  public isEmpty(): boolean {
    return this._trades.length === 0;
  }
}

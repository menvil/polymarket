/**
 * PolymarketMarketCatalog — каталог инструментов Polymarket.
 *
 * @remarks
 * Загружает метаданные инструментов из Polymarket REST API при старте.
 *
 * ### Дизайн:
 * - `IMarketCatalog` / `InstrumentInfo` будут импортироваться из `@polymarket/ports`
 *   после Phase 1. Пока определены inline как stub.
 * - Строки из REST API (tick size, min order size) парсятся в domain VOs здесь —
 *   на границе инфраструктуры. Application layer получает готовые типизированные объекты.
 * - `RawMarketResponse` — приватный тип для wire-формата Polymarket Gamma API.
 *   Не экспортируется — живёт только внутри этого модуля.
 *
 * ### Поток:
 * ```
 * Polymarket Gamma API
 *   → PolymarketMarketDataRestClient.getMarkets()  (raw JSON)
 *   → PolymarketMarketCatalog._parse()              (strings → VOs)
 *   → InstrumentInfo                                (typed domain objects)
 *   → BookUpdateHandler, OrderRiskChecker (Phase 3/4)
 * ```
 *
 * @example
 * ```typescript
 * const catalog = new PolymarketMarketCatalog(restClient, logger);
 * await catalog.load();
 *
 * const info = catalog.get(tokenId);
 * if (info) {
 *   console.log('Tick size:', info.tickSize.toString());
 *   console.log('Min order:', info.minOrderSize.toString());
 * }
 * ```
 */

// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import { Price } from '@polymarket/value-objects';
import { Quantity } from '@polymarket/value-objects';
import type { InstrumentId } from '@polymarket/ids';
import { asInstrumentId } from '@polymarket/ids';
import type { PolymarketMarketDataRestClient } from './clients/PolymarketMarketDataRestClient.js';

// TODO: После Phase 1 заменить на import из '@polymarket/ports'
// import type { IMarketCatalog, InstrumentInfo } from '@polymarket/ports';

/**
 * Метаданные инструмента (tokenId + рыночные ограничения).
 *
 * @remarks
 * После Phase 1: будет импортироваться из `@polymarket/ports`.
 */
export interface InstrumentInfo {
  /** ID токена (UP/DOWN outcome token) */
  readonly instrumentId: InstrumentId;
  /** ID условия рынка (condition_id) */
  readonly conditionId: string;
  /** Минимальный шаг цены */
  readonly tickSize: Price;
  /** Минимальный размер ордера */
  readonly minOrderSize: Quantity;
  /** Активен ли рынок */
  readonly active: boolean;
  /** Slug рынка (для отладки) */
  readonly marketSlug?: string;
}

/**
 * Интерфейс каталога инструментов.
 *
 * @remarks
 * После Phase 1: будет импортироваться из `@polymarket/ports`.
 */
export interface IMarketCatalog {
  get(tokenId: string): InstrumentInfo | undefined;
  getAll(): readonly InstrumentInfo[];
}

/**
 * Сырой ответ Polymarket Gamma API для рынка.
 *
 * @remarks
 * INTERNAL — не экспортируется. Представляет wire-формат REST.
 */
interface RawMarketResponse {
  readonly condition_id: string;
  readonly tokens: ReadonlyArray<{
    readonly token_id: string;
    readonly outcome: string;
  }>;
  readonly minimum_tick_size: string;
  readonly minimum_order_size: string;
  readonly market_slug?: string;
  readonly active: boolean;
}

/**
 * PolymarketMarketCatalog — реализация IMarketCatalog для Polymarket REST API.
 *
 * @remarks
 * Загружает метаданные при старте (метод `load()`).
 * Строки REST-ответа парсятся в `Price` / `Quantity` VOs на границе инфраструктуры.
 * Application layer работает исключительно с типизированными объектами.
 */
export class PolymarketMarketCatalog implements IMarketCatalog {
  /** Индекс по tokenId → InstrumentInfo */
  private readonly _byTokenId = new Map<string, InstrumentInfo>();

  /**
   * Создаёт каталог (не загружает данные — вызовите `load()`).
   *
   * @param _restClient - REST-клиент для Polymarket Gamma API
   * @param _logger - Logger
   */
  constructor(
    private readonly _restClient: PolymarketMarketDataRestClient,
    private readonly _logger: ILogger,
  ) {}

  /**
   * Загружает каталог из Polymarket REST API.
   *
   * @remarks
   * Вызывается при старте системы перед началом торговли.
   * Повторный вызов перезаписывает кэш (reload).
   *
   * @throws {Error} Если REST-запрос завершился ошибкой
   *
   * @example
   * ```typescript
   * await catalog.load();
   * console.log(`Loaded ${catalog.getAll().length} instruments`);
   * ```
   */
  async load(): Promise<void> {
    const raw = await this._restClient.getActiveMarkets() as unknown as RawMarketResponse[];

    // Очищаем кэш перед загрузкой, чтобы удалённые из API токены не остались в памяти
    this._byTokenId.clear();

    let count = 0;
    for (const market of raw) {
      for (const token of market.tokens) {
        const info = this._parse(market, token.token_id);
        if (info) {
          this._byTokenId.set(token.token_id, info);
          count++;
        }
      }
    }

    this._logger.info('[PolymarketMarketCatalog] Catalog loaded', { count });
  }

  /**
   * Возвращает метаданные инструмента по tokenId.
   *
   * @param tokenId - Token ID (YES или NO токен)
   * @returns InstrumentInfo или undefined если не найден
   *
   * @example
   * ```typescript
   * const info = catalog.get(tokenId);
   * if (info) {
   *   // info.tickSize уже Price — не нужно парсить строку
   *   validatePrice(price, info.tickSize);
   * }
   * ```
   */
  get(tokenId: string): InstrumentInfo | undefined {
    return this._byTokenId.get(tokenId);
  }

  /**
   * Возвращает все загруженные инструменты.
   *
   * @returns Readonly массив всех InstrumentInfo
   */
  getAll(): readonly InstrumentInfo[] {
    return Array.from(this._byTokenId.values());
  }

  /**
   * Парсит сырой REST-ответ в InstrumentInfo с domain VOs.
   *
   * @param raw - Сырой ответ Polymarket API
   * @param tokenId - Token ID (UP/DOWN токен)
   * @returns InstrumentInfo или null если парсинг не удался
   *
   * @remarks
   * Строки → Price / Quantity происходит здесь — на границе инфраструктуры.
   * Невалидные данные логируются и пропускаются (не бросают исключений).
   */
  private _parse(raw: RawMarketResponse, tokenId: string): InstrumentInfo | null {
    try {
      const instrumentId = asInstrumentId(tokenId);
      if (!instrumentId) {
        this._logger.warn('[PolymarketMarketCatalog] Invalid tokenId, skipping', { tokenId });
        return null;
      }

      const tickSize = Price.of(new Decimal(raw.minimum_tick_size));
      const minOrderSize = Quantity.of(new Decimal(raw.minimum_order_size));

      return {
        instrumentId,
        conditionId: raw.condition_id,
        tickSize,
        minOrderSize,
        active: raw.active,
        marketSlug: raw.market_slug,
      };
    } catch (err) {
      this._logger.warn('[PolymarketMarketCatalog] Failed to parse market, skipping', {
        conditionId: raw.condition_id,
        tokenId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return null;
    }
  }
}

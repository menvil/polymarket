/**
 * @polymarket/ports — Application-layer порты.
 *
 * @remarks
 * Dependency Inversion — use-cases, handlers и strategy зависят от этих интерфейсов,
 * а не от конкретных инфраструктурных реализаций.
 *
 * ### Содержимое пакета:
 * - `IOrderRepository` — хранилище Order агрегатов
 * - `IPortfolioStore` — хранилище Portfolio с CAS-защитой
 * - `VersionConflictError` — ошибка конфликта версий (CAS)
 * - `IProcessedFillRepository` — idempotency guard для Fill
 * - `IExchangeClient` / `SubmitOrderParams` / `ExchangeError` — торговый клиент
 * - `IMarketCatalog` / `InstrumentInfo` — каталог инструментов
 *
 * @example
 * ```typescript
 * import type {
 *   IOrderRepository,
 *   IPortfolioStore,
 *   IExchangeClient,
 *   IMarketCatalog,
 * } from '@polymarket/ports';
 * ```
 */

export type { IOrderRepository } from './IOrderRepository.js';
export type { IPortfolioStore } from './IPortfolioStore.js';
export { VersionConflictError } from './VersionConflictError.js';
export type { IProcessedFillRepository } from './IProcessedFillRepository.js';
export { ExchangeError } from './IExchangeClient.js';
export type { IExchangeClient, SubmitOrderParams } from './IExchangeClient.js';
export type { IMarketCatalog, InstrumentInfo } from './IMarketCatalog.js';

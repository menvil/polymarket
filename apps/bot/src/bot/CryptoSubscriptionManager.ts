// TODO: вынести CryptoSubscriptionManager в shared пакет (@polymarket/crypto-subscriptions)
// чтобы data collector (packages/apps/collect-data) использовал тот же код вместо
// своей реализации symbolToTokenIds в main.ts.

/**
 * CryptoSubscriptionManager — управление RTDS подписками на крипто-цены.
 *
 * @remarks
 * Единый модуль для paper, live и (в будущем) data collector.
 * Использует ref-counting через `symbolToTokenIds` Map<Set>:
 * каждый символ (btc/usd) трекает какие рынки (tokenId) его используют.
 * Отписка от RTDS происходит только когда ни один рынок не использует символ.
 *
 * ### Паттерн использования:
 * ```
 * subscribeMarket(tokenId, cryptoMeta)  ← при открытии рынка
 * // closeMarket: ничего не делаем (deferred cleanup)
 * cleanupUnused(activeTokenIds)          ← после fillMarketSlots
 * ```
 *
 * ### Сценарии:
 * - BTC→BTC: subscribe idempotent, cleanup ничего не делает (символ тот же)
 * - BTC→SOL: cleanup отписывает btc/usd после открытия SOL
 * - BTC+SOL concurrent: cleanup не трогает btc/usd пока BTC рынок активен
 *
 * @example
 * ```typescript
 * const subs = new CryptoSubscriptionManager(rtdsClient, logger);
 * subs.subscribeMarket('token123', cryptoMeta);
 * // ... рынок закрылся, новый открылся ...
 * subs.cleanupUnused(new Set(activeMarkets.keys()));
 * ```
 */

import type { ILogger } from '@polymarket/logger';

/**
 * Минимальный интерфейс RTDS клиента (для DI — не зависим от конкретной реализации).
 */
interface IRtdsClient {
  subscribe(topic: string, filter: string): void;
  unsubscribe(topic: string, filter: string): void;
}

/**
 * Метаданные крипто-рынка с подписками RTDS.
 */
interface CryptoMeta {
  readonly rtdsSubscriptions: ReadonlyArray<{ readonly topic: string; readonly filter: string }>;
}

export class CryptoSubscriptionManager {
  private readonly _logger: ILogger;
  /**
   * symbol (filter) → Set<tokenId>
   * Трекает какие рынки используют каждый символ.
   */
  private readonly _symbolToTokenIds = new Map<string, Set<string>>();

  constructor(
    private readonly _rtdsClient: IRtdsClient,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'CryptoSubscriptionManager' });
  }

  /**
   * Подписать символы рынка.
   *
   * @param tokenId - Уникальный ID рынка (tokenIdStr)
   * @param cryptoMeta - Метаданные с RTDS подписками
   */
  subscribeMarket(tokenId: string, cryptoMeta: CryptoMeta): void {
    for (const sub of cryptoMeta.rtdsSubscriptions) {
      // Добавляем tokenId в set для этого символа
      let ids = this._symbolToTokenIds.get(sub.filter);
      if (!ids) {
        ids = new Set();
        this._symbolToTokenIds.set(sub.filter, ids);
      }
      ids.add(tokenId);

      // Подписываемся на RTDS (idempotent — RtdsWebSocketClient игнорирует дубли)
      this._rtdsClient.subscribe(sub.topic, sub.filter);
    }
  }

  /**
   * Deferred cleanup: отписать символы которые не нужны ни одному активному рынку.
   *
   * @param activeTokenIds - Множество tokenId всех активных рынков
   *
   * @remarks
   * Вызывать ПОСЛЕ fillMarketSlots (когда новые рынки уже открыты).
   * Для каждого символа проверяем пересечение tokenIds с activeTokenIds.
   * Если пересечение пустое — символ не нужен, отписываемся.
   */
  cleanupUnused(activeTokenIds: Set<string>): void {
    for (const [filter, ids] of this._symbolToTokenIds) {
      // Удаляем неактивные tokenIds из set
      for (const id of ids) {
        if (!activeTokenIds.has(id)) {
          ids.delete(id);
        }
      }

      // Если set пуст — ни один активный рынок не использует символ
      if (ids.size === 0) {
        this._symbolToTokenIds.delete(filter);
        this._rtdsClient.unsubscribe('crypto_prices_chainlink', filter);
        this._rtdsClient.unsubscribe('crypto_prices', filter);
        this._logger.debug('RTDS symbol unsubscribed (no active markets)', { filter });
      }
    }
  }
}

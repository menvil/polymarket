/**
 * Trading Flow integration tests
 *
 * @remarks
 * Тестирует взаимодействие Market, OutcomeToken и Trade entities.
 * Проверяет полный flow создания рынка и сделок.
 */

import { describe, it, expect } from '@jest/globals';
import { Market } from '../../src/Market';
import { Trade } from '../../src/Trade';
import { Price, Quantity } from '@polymarket/value-objects';

describe('Trading Flow Integration', () => {
  describe('Market → OutcomeToken → Trade flow', () => {
    it('should create market and trade on outcome token', () => {
      // 1. Создаём рынок
      const marketResult = Market.create({
        id: 'market-btc-100k',
        slug: 'btc-100k-2024',
        question: 'Will BTC reach $100k in 2024?',
        outcomeNames: ['Yes', 'No'],
        outcomeTokenIds: ['token-yes-abc', 'token-no-def'],
        expirationDate: new Date('2024-12-31T23:59:59Z'),
        status: 'ACTIVE'
      });

      expect(marketResult.ok).toBe(true);
      if (!marketResult.ok) return;

      const market = marketResult.value;

      // 2. Получаем outcome token
      const yesToken = market.getOutcomeToken(0);

      expect(yesToken.id).toBe('token-yes-abc');
      expect(yesToken.marketId).toBe('market-btc-100k');
      expect(yesToken.name).toBe('Yes');
      expect(yesToken.outcomeIndex).toBe(0);

      // 3. Создаём сделку на этом токене
      const tradeResult = Trade.create({
        id: 'trade-1',
        marketId: market.id,
        tokenId: yesToken.id,
        price: Price.fromValue(0.65).value!,
        size: Quantity.fromValue(100).value!,
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc123...'
      });

      expect(tradeResult.ok).toBe(true);
      if (!tradeResult.ok) return;

      const trade = tradeResult.value;

      // 4. Проверяем связность данных
      expect(trade.marketId).toBe(market.id);
      expect(trade.tokenId).toBe(yesToken.id);

      // 5. Можем получить token обратно из market по ID из trade
      const tokenFromMarket = market.getOutcomeTokenById(trade.tokenId);
      expect(tokenFromMarket).not.toBe(null);
      expect(tokenFromMarket?.equals(yesToken)).toBe(true);
    });

    it('should handle trades on both outcome tokens', () => {
      // Создаём рынок
      const marketResult = Market.create({
        id: 'market-election',
        slug: 'election-2024',
        question: 'Will candidate A win?',
        outcomeNames: ['Yes', 'No'],
        outcomeTokenIds: ['token-yes-election', 'token-no-election'],
        expirationDate: new Date('2024-11-05T23:59:59Z'),
        status: 'ACTIVE'
      });

      expect(marketResult.ok).toBe(true);
      if (!marketResult.ok) return;

      const market = marketResult.value;

      // Создаём сделки на оба токена
      const buyYesResult = Trade.create({
        id: 'trade-buy-yes',
        marketId: market.id,
        tokenId: market.getOutcomeToken(0).id,
        price: Price.fromValue(0.60).value!,
        size: Quantity.fromValue(50).value!,
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc1...'
      });

      const sellNoResult = Trade.create({
        id: 'trade-sell-no',
        marketId: market.id,
        tokenId: market.getOutcomeToken(1).id,
        price: Price.fromValue(0.40).value!,
        size: Quantity.fromValue(75).value!,
        side: 'SELL',
        timestamp: new Date(),
        transactionHash: '0xabc2...'
      });

      expect(buyYesResult.ok && sellNoResult.ok).toBe(true);
      if (!buyYesResult.ok || !sellNoResult.ok) return;

      // Проверяем что сделки на разных токенах
      expect(buyYesResult.value.tokenId).not.toBe(sellNoResult.value.tokenId);

      // Но на одном рынке
      expect(buyYesResult.value.marketId).toBe(sellNoResult.value.marketId);

      // Проверяем что можем получить правильные outcome tokens
      const yesToken = market.getOutcomeTokenById(buyYesResult.value.tokenId);
      const noToken = market.getOutcomeTokenById(sellNoResult.value.tokenId);

      expect(yesToken?.name).toBe('Yes');
      expect(noToken?.name).toBe('No');
    });
  });

  describe('Market lifecycle with trades', () => {
    it('should allow trading on ACTIVE market', () => {
      const marketResult = Market.create({
        id: 'market-active',
        slug: 'market-active-slug',
        question: 'Active market?',
        outcomeNames: ['Yes', 'No'],
        outcomeTokenIds: ['token-yes', 'token-no'],
        expirationDate: new Date(Date.now() + 1000 * 60 * 60 * 24), // +1 day
        status: 'ACTIVE'
      });

      expect(marketResult.ok).toBe(true);
      if (!marketResult.ok) return;

      const market = marketResult.value;

      // Должен разрешать торговлю
      expect(market.canTrade()).toBe(true);

      // Создание сделки должно работать
      const tradeResult = Trade.create({
        id: 'trade-1',
        marketId: market.id,
        tokenId: market.getOutcomeToken(0).id,
        price: Price.fromValue(0.50).value!,
        size: Quantity.fromValue(10).value!,
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc...'
      });

      expect(tradeResult.ok).toBe(true);
    });

    it('should not allow trading on CLOSED market', () => {
      const marketResult = Market.create({
        id: 'market-closed',
        slug: 'market-closed-slug',
        question: 'Closed market?',
        outcomeNames: ['Yes', 'No'],
        outcomeTokenIds: ['token-yes', 'token-no'],
        expirationDate: new Date(Date.now() + 1000 * 60 * 60 * 24),
        status: 'CLOSED'
      });

      expect(marketResult.ok).toBe(true);
      if (!marketResult.ok) return;

      const market = marketResult.value;

      // Не должен разрешать торговлю
      expect(market.canTrade()).toBe(false);

      // Но создание сделки технически возможно (валидация на уровне приложения)
      const tradeResult = Trade.create({
        id: 'trade-1',
        marketId: market.id,
        tokenId: market.getOutcomeToken(0).id,
        price: Price.fromValue(0.50).value!,
        size: Quantity.fromValue(10).value!,
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc...'
      });

      expect(tradeResult.ok).toBe(true);
    });

    it('should identify winning outcome after market resolution', () => {
      // 1. Создаём рынок
      const marketResult = Market.create({
        id: 'market-to-resolve',
        slug: 'market-to-resolve-slug',
        question: 'Outcome?',
        outcomeNames: ['Yes', 'No'],
        outcomeTokenIds: ['token-yes', 'token-no'],
        expirationDate: new Date(Date.now() + 1000 * 60 * 60 * 24),
        status: 'ACTIVE'
      });

      expect(marketResult.ok).toBe(true);
      if (!marketResult.ok) return;

      // 2. Создаём сделки на оба токена
      const buyYesResult = Trade.create({
        id: 'trade-yes',
        marketId: marketResult.value.id,
        tokenId: marketResult.value.getOutcomeToken(0).id,
        price: Price.fromValue(0.70).value!,
        size: Quantity.fromValue(100).value!,
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc1...'
      });

      const buyNoResult = Trade.create({
        id: 'trade-no',
        marketId: marketResult.value.id,
        tokenId: marketResult.value.getOutcomeToken(1).id,
        price: Price.fromValue(0.30).value!,
        size: Quantity.fromValue(50).value!,
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc2...'
      });

      expect(buyYesResult.ok && buyNoResult.ok).toBe(true);

      // 3. Закрываем рынок
      const closedMarket = marketResult.value.close();
      expect(closedMarket.canTrade()).toBe(false);

      // 4. Разрешаем рынок (Yes wins)
      const resolveResult = closedMarket.resolve(0);

      expect(resolveResult.ok).toBe(true);
      if (!resolveResult.ok) return;

      const resolvedMarket = resolveResult.value;

      // 5. Проверяем выигравший исход
      const winningToken = resolvedMarket.getResolvedOutcomeToken();
      expect(winningToken).not.toBe(null);
      expect(winningToken?.name).toBe('Yes');

      // 6. Можем проверить что купленный токен - выигрышный
      if (buyYesResult.ok && winningToken) {
        expect(buyYesResult.value.tokenId).toBe(winningToken.id);
      }
    });
  });

  describe('Polymarket event integration', () => {
    it('should parse Polymarket event and link to market', () => {
      // 1. Создаём рынок
      const marketResult = Market.create({
        id: 'market-xyz',
        slug: 'polymarket-integration',
        question: 'Integration test?',
        outcomeNames: ['Yes', 'No'],
        outcomeTokenIds: ['token-yes-xyz', 'token-no-xyz'],
        expirationDate: new Date('2024-12-31'),
        status: 'ACTIVE'
      });

      expect(marketResult.ok).toBe(true);
      if (!marketResult.ok) return;

      const market = marketResult.value;

      // 2. Получаем Polymarket event из WebSocket
      const polymarketEvent = {
        market: market.id,
        asset_id: market.getOutcomeToken(0).id,
        price: '0.65',
        size: '100.5',
        side: 'BUY',
        timestamp: '1705315800000',
        transaction_hash: '0x1234abcd...'
      };

      // 3. Парсим событие в Trade
      const tradeResult = Trade.fromPolymarketEvent(polymarketEvent);

      expect(tradeResult.ok).toBe(true);
      if (!tradeResult.ok) return;

      const trade = tradeResult.value;

      // 4. Проверяем связность
      expect(trade.marketId).toBe(market.id);
      expect(trade.tokenId).toBe(market.getOutcomeToken(0).id);

      // 5. Можем получить outcome token из market
      const outcomeToken = market.getOutcomeTokenById(trade.tokenId);
      expect(outcomeToken).not.toBe(null);
      expect(outcomeToken?.name).toBe('Yes');
      expect(outcomeToken?.outcomeIndex).toBe(0);
    });

    it('should handle multiple Polymarket events for same market', () => {
      const marketResult = Market.create({
        id: 'market-multi',
        slug: 'multi-trades',
        question: 'Multiple trades?',
        outcomeNames: ['Yes', 'No'],
        outcomeTokenIds: ['token-yes-multi', 'token-no-multi'],
        expirationDate: new Date('2024-12-31'),
        status: 'ACTIVE'
      });

      expect(marketResult.ok).toBe(true);
      if (!marketResult.ok) return;

      const market = marketResult.value;

      // Множество событий от Polymarket
      const events = [
        {
          market: market.id,
          asset_id: market.getOutcomeToken(0).id,
          price: '0.60',
          size: '50',
          side: 'BUY',
          timestamp: '1705315800000',
          transaction_hash: '0xabc1...'
        },
        {
          market: market.id,
          asset_id: market.getOutcomeToken(1).id,
          price: '0.40',
          size: '75',
          side: 'SELL',
          timestamp: '1705315900000',
          transaction_hash: '0xabc2...'
        },
        {
          market: market.id,
          asset_id: market.getOutcomeToken(0).id,
          price: '0.65',
          size: '100',
          side: 'BUY',
          timestamp: '1705316000000',
          transaction_hash: '0xabc3...'
        }
      ];

      // Парсим все события
      const trades = events
        .map((event) => Trade.fromPolymarketEvent(event))
        .filter((result) => result.ok)
        .map((result) => (result.ok ? result.value : null))
        .filter((trade): trade is NonNullable<typeof trade> => trade !== null);

      // Все события успешно распарсены
      expect(trades).toHaveLength(3);

      // Все сделки относятся к одному рынку
      expect(trades.every((trade) => trade.marketId === market.id)).toBe(true);

      // Проверяем распределение по токенам
      const yesTrades = trades.filter((t) => t.tokenId === market.getOutcomeToken(0).id);
      const noTrades = trades.filter((t) => t.tokenId === market.getOutcomeToken(1).id);

      expect(yesTrades).toHaveLength(2);
      expect(noTrades).toHaveLength(1);
    });
  });

  describe('JSON serialization integration', () => {
    it('should serialize and deserialize complete trading scenario', () => {
      // 1. Создаём рынок
      const marketResult = Market.create({
        id: 'market-json',
        slug: 'json-test',
        question: 'JSON test?',
        outcomeNames: ['Yes', 'No'],
        outcomeTokenIds: ['token-yes-json', 'token-no-json'],
        expirationDate: new Date('2024-12-31T23:59:59Z'),
        status: 'ACTIVE'
      });

      expect(marketResult.ok).toBe(true);
      if (!marketResult.ok) return;

      const market = marketResult.value;

      // 2. Создаём сделку
      const tradeResult = Trade.create({
        id: 'trade-json',
        marketId: market.id,
        tokenId: market.getOutcomeToken(0).id,
        price: Price.fromValue(0.65).value!,
        size: Quantity.fromValue(100).value!,
        side: 'BUY',
        timestamp: new Date('2024-01-15T10:30:00Z'),
        transactionHash: '0xjson...'
      });

      expect(tradeResult.ok).toBe(true);
      if (!tradeResult.ok) return;

      const trade = tradeResult.value;

      // 3. Сериализуем оба
      const marketJson = market.toJSON();
      const tradeJson = trade.toJSON();

      // 4. Десериализуем
      const marketFromJsonResult = Market.fromJSON(marketJson);
      const tradeFromJsonResult = Trade.fromJSON(tradeJson);

      expect(marketFromJsonResult.ok && tradeFromJsonResult.ok).toBe(true);
      if (!marketFromJsonResult.ok || !tradeFromJsonResult.ok) return;

      const marketRestored = marketFromJsonResult.value;
      const tradeRestored = tradeFromJsonResult.value;

      // 5. Проверяем что связность сохранилась
      expect(tradeRestored.marketId).toBe(marketRestored.id);

      const outcomeToken = marketRestored.getOutcomeTokenById(tradeRestored.tokenId);
      expect(outcomeToken).not.toBe(null);
      expect(outcomeToken?.name).toBe('Yes');
    });
  });
});

/**
 * Тесты для MockExchangeClient — симулятора биржевого клиента.
 *
 * @remarks
 * Проверяет корректность симуляции торговых операций:
 * - Генерацию уникальных OrderId
 * - Хранение поданных ордеров
 * - Отмену ордеров
 * - Возврат пустых массивов для getOpenOrders/getTrades
 * - Сброс состояния через reset()
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { PaperClock } from '@polymarket/time';
import { MockExchangeClient } from '../src/MockExchangeClient.js';
import type { SubmitOrderParams } from '@polymarket/ports';
import { Price, Quantity } from '@polymarket/value-objects';
import { asPolymarketCtfToken, parseAccountId } from '@polymarket/ids';
import Decimal from 'decimal.js';

/** Детерминированный clock для тестов */
const clock = new PaperClock(new Date(1_700_000_000_000));

/** Тестовый AssetId: POLYMARKET_CTF_TOKEN */
const TEST_ASSET = asPolymarketCtfToken('1')!;

/** Вспомогательная фабрика параметров ордера */
function makeOrderParams(): SubmitOrderParams {
  return {
    asset: TEST_ASSET,
    side: 'BUY' as const,
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('100')),
  };
}

/**
 * Вспомогательный AccountId: venue:POLYMARKET:testuser.
 * parseAccountId возвращает AccountId | undefined; здесь мы уверены что строка валидна.
 */
const testAccountId = parseAccountId('venue:POLYMARKET:testuser')!;

describe('MockExchangeClient', () => {
  let client: MockExchangeClient;

  beforeEach(() => {
    client = new MockExchangeClient(clock);
  });

  // ── submitOrder ────────────────────────────────────────────────────────────

  describe('submitOrder()', () => {
    it('возвращает Ok с уникальным OrderId', async () => {
      const result = await client.submitOrder(makeOrderParams());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value.orderId).toBe('string');
        expect(String(result.value.orderId).length).toBeGreaterThan(0);
        expect(result.value.immediatelyMatched).toBe(false);
      }
    });

    it('генерирует уникальные OrderId для каждого ордера', async () => {
      const r1 = await client.submitOrder(makeOrderParams());
      const r2 = await client.submitOrder(makeOrderParams());
      const r3 = await client.submitOrder(makeOrderParams());

      expect(r1.ok && r2.ok && r3.ok).toBe(true);
      if (r1.ok && r2.ok && r3.ok) {
        const ids = new Set([r1.value, r2.value, r3.value]);
        expect(ids.size).toBe(3);
      }
    });

    it('сохраняет поданный ордер в getSubmittedOrders()', async () => {
      const params = makeOrderParams();
      await client.submitOrder(params);

      const submitted = client.getSubmittedOrders();
      expect(submitted).toHaveLength(1);
      expect(submitted[0].params).toBe(params);
      expect(submitted[0].submittedAt).toBeInstanceOf(Date);
    });

    it('сохраняет все поданные ордера', async () => {
      await client.submitOrder(makeOrderParams());
      await client.submitOrder(makeOrderParams());
      await client.submitOrder(makeOrderParams());

      expect(client.getSubmittedOrders()).toHaveLength(3);
    });

    it('OrderId в getSubmittedOrders() совпадает с возвращённым значением', async () => {
      const result = await client.submitOrder(makeOrderParams());
      expect(result.ok).toBe(true);

      if (result.ok) {
        const submitted = client.getSubmittedOrders();
        expect(submitted[0].orderId).toBe(result.value.orderId);
      }
    });
  });

  // ── cancelOrder ───────────────────────────────────────────────────────────

  describe('cancelOrder()', () => {
    it('возвращает Ok(undefined)', async () => {
      const submitResult = await client.submitOrder(makeOrderParams());
      expect(submitResult.ok).toBe(true);

      if (submitResult.ok) {
        const cancelResult = await client.cancelOrder(submitResult.value.orderId);
        expect(cancelResult.ok).toBe(true);
        if (cancelResult.ok) {
          expect(cancelResult.value).toBeUndefined();
        }
      }
    });

    it('помечает ордер как отменённый', async () => {
      const submitResult = await client.submitOrder(makeOrderParams());
      expect(submitResult.ok).toBe(true);

      if (submitResult.ok) {
        const orderId = submitResult.value.orderId;
        expect(client.isCancelled(orderId)).toBe(false);

        await client.cancelOrder(orderId);
        expect(client.isCancelled(orderId)).toBe(true);
      }
    });

    it('не выбрасывает при отмене несуществующего ордера', async () => {
      // asOrderId возвращает OrderId | undefined, здесь строка намеренно валидна
      const { asOrderId } = await import('@polymarket/ids');
      const fakeOrderId = asOrderId('order-nonexistent')!;

      await expect(
        client.cancelOrder(fakeOrderId),
      ).resolves.toMatchObject({ ok: true });
    });
  });

  // ── getOpenOrders ─────────────────────────────────────────────────────────

  describe('getOpenOrders()', () => {
    it('всегда возвращает Ok с пустым массивом', async () => {
      // Подаём ордер, но getOpenOrders всё равно должен вернуть []
      await client.submitOrder(makeOrderParams());

      const result = await client.getOpenOrders(testAccountId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });

  // ── getTrades ─────────────────────────────────────────────────────────────

  describe('getTrades()', () => {
    it('всегда возвращает Ok с пустым массивом', async () => {
      const result = await client.getTrades(testAccountId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it('возвращает Ok с пустым массивом даже с параметром since', async () => {
      // since — опциональный параметр, тестируем его передачу
      const result = await client.getTrades(testAccountId, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });

  // ── getSubmittedOrders ────────────────────────────────────────────────────

  describe('getSubmittedOrders()', () => {
    it('возвращает пустой массив если ни одного ордера не было подано', () => {
      expect(client.getSubmittedOrders()).toHaveLength(0);
    });

    it('возвращает копию — мутации не влияют на внутренний список', async () => {
      await client.submitOrder(makeOrderParams());

      const snapshot1 = client.getSubmittedOrders();
      // Попытка мутировать возвращённый массив
      (snapshot1 as unknown as unknown[]).push({ fake: true });

      // Следующий вызов должен вернуть неизменённое состояние
      const snapshot2 = client.getSubmittedOrders();
      expect(snapshot2).toHaveLength(1);
    });
  });

  // ── reset ─────────────────────────────────────────────────────────────────

  describe('reset()', () => {
    it('очищает список поданных ордеров', async () => {
      await client.submitOrder(makeOrderParams());
      await client.submitOrder(makeOrderParams());
      expect(client.getSubmittedOrders()).toHaveLength(2);

      client.reset();
      expect(client.getSubmittedOrders()).toHaveLength(0);
    });

    it('сбрасывает отменённые ордера', async () => {
      const result = await client.submitOrder(makeOrderParams());
      if (result.ok) {
        await client.cancelOrder(result.value.orderId);
        expect(client.isCancelled(result.value.orderId)).toBe(true);
      }

      client.reset();

      if (result.ok) {
        expect(client.isCancelled(result.value.orderId)).toBe(false);
      }
    });

    it('сбрасывает счётчик OrderId (после reset счётчик начинается с 1)', async () => {
      await client.submitOrder(makeOrderParams());
      await client.submitOrder(makeOrderParams());
      client.reset();

      const r1 = await client.submitOrder(makeOrderParams());
      const r2 = await client.submitOrder(makeOrderParams());

      if (r1.ok && r2.ok) {
        expect(r1.value.orderId).not.toBe(r2.value.orderId);
        // После сброса счётчик начинается заново — суффикс -1
        expect(String(r1.value.orderId)).toMatch(/-1$/);
      }
    });
  });
});

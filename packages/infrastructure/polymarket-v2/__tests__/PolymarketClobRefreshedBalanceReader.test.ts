/**
 * `PolymarketClobRefreshedBalanceReader`: обновлённый CLOB-баланс → canonical
 * `Money`/`Quantity`.
 *
 * @remarks
 * Главное, что здесь проверяется, — отказ НИКОГДА не превращается в ноль:
 * транспорт, схема и само значение (`undefined`, `NaN`, отрицательное,
 * дробное, слишком длинное) дают `Err`. Ноль — только настоящий ноль.
 */
import { describe, expect, it } from '@jest/globals';
import type { BalanceAllowanceResponse } from '@polymarket/bindings/clob';
import type { BaseSecureClient } from '@polymarket/client';
import type { UpdateBalanceAllowanceRequest } from '@polymarket/client/actions';
import { parseAssetId } from '@polymarket/ids';
import {
  PolymarketClobRefreshedBalanceReader,
  type PolymarketBalanceAllowanceRefresher,
  type PolymarketBalanceAllowanceRequest,
} from '@polymarket/polymarket-v2/account';
import { OUR_ADDRESS, YES, YES_TOKEN_ID } from './helpers/accountFixtures.js';

/** Fake-порт обновления: записывает запросы и отдаёт заданный баланс. */
class FakeRefresher implements PolymarketBalanceAllowanceRefresher {
  public readonly requests: PolymarketBalanceAllowanceRequest[] = [];

  constructor(private readonly _respond: () => Promise<BalanceAllowanceResponse>) {}

  public updateBalanceAllowance(request: PolymarketBalanceAllowanceRequest): Promise<BalanceAllowanceResponse> {
    this.requests.push(request);
    return this._respond();
  }
}

/** Ответ SDK с заданным `balance` (как есть, в том числе невалидным). */
function respondWith(balance: unknown): () => Promise<BalanceAllowanceResponse> {
  return () => Promise.resolve({ balance, allowances: {} } as unknown as BalanceAllowanceResponse);
}

describe('collateral', () => {
  it('updateBalanceAllowance(COLLATERAL) → точные Money в USDC из базовых единиц', async () => {
    const refresher = new FakeRefresher(respondWith('1234567890'));
    const reader = new PolymarketClobRefreshedBalanceReader(refresher, OUR_ADDRESS);

    const collateral = await reader.getCollateralBalance();

    expect(refresher.requests).toEqual([{ assetType: 'COLLATERAL' }]);
    expect(collateral.ok && collateral.value.value().toString()).toBe('1234.56789');
    expect(collateral.ok && collateral.value.currency()).toBe('USDC');
  });

  it('настоящий ноль — ноль, а не отказ', async () => {
    const reader = new PolymarketClobRefreshedBalanceReader(new FakeRefresher(respondWith('0')), OUR_ADDRESS);
    const collateral = await reader.getCollateralBalance();
    expect(collateral.ok && collateral.value.isZero()).toBe(true);
  });

  it('отказ SDK → Err с исходной причиной, не ноль', async () => {
    const cause = new Error('HTTP 503');
    const reader = new PolymarketClobRefreshedBalanceReader(new FakeRefresher(() => Promise.reject(cause)), OUR_ADDRESS);

    const collateral = await reader.getCollateralBalance();

    expect(collateral.ok).toBe(false);
    if (collateral.ok) return;
    expect(collateral.error.message).toContain('collateral');
    expect(collateral.error.cause).toBe(cause);
  });
});

describe('outcome-токен', () => {
  it('updateBalanceAllowance(CONDITIONAL, tokenId) → точное Quantity', async () => {
    const refresher = new FakeRefresher(respondWith('2500000'));
    const reader = new PolymarketClobRefreshedBalanceReader(refresher, OUR_ADDRESS);

    const balance = await reader.getOutcomeAssetBalance(YES);

    expect(refresher.requests).toEqual([{ assetType: 'CONDITIONAL', tokenId: YES_TOKEN_ID }]);
    expect(balance.ok && balance.value.value().toString()).toBe('2.5');
  });

  it('дробные базовые единицы сохраняются точно (1 → 0.000001)', async () => {
    const reader = new PolymarketClobRefreshedBalanceReader(new FakeRefresher(respondWith('1')), OUR_ADDRESS);
    const balance = await reader.getOutcomeAssetBalance(YES);
    expect(balance.ok && balance.value.value().toString()).toBe('0.000001');
  });

  it('OUTCOME_TOKEN без CLOB token id → Err, без запроса', async () => {
    const refresher = new FakeRefresher(respondWith('1'));
    const reader = new PolymarketClobRefreshedBalanceReader(refresher, OUR_ADDRESS);
    const onChain = parseAssetId(`OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0x${'a'.repeat(64)}:UP`);
    if (onChain === undefined || onChain.type !== 'OUTCOME_TOKEN') throw new Error('fixture failed');

    const balance = await reader.getOutcomeAssetBalance(onChain);

    expect(balance.ok).toBe(false);
    expect(refresher.requests).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['NaN', 'NaN'],
    ['отрицательное', '-5'],
    ['дробное', '1.5'],
    ['экспонента', '1e6'],
    ['пробелы', ' 5'],
    ['число вместо строки', 5],
    ['переполнение', '9'.repeat(23)],
  ])('невалидный баланс (%s) → Err, не ноль', async (_label, raw) => {
    const reader = new PolymarketClobRefreshedBalanceReader(new FakeRefresher(respondWith(raw)), OUR_ADDRESS);

    const balance = await reader.getOutcomeAssetBalance(YES);
    const collateral = await reader.getCollateralBalance();

    expect(balance.ok).toBe(false);
    expect(collateral.ok).toBe(false);
  });
});

describe('fromSdk: привязка к action-функции SDK', () => {
  it('передаёт тот же клиент и enum-значения AssetType SDK; reader обновляет баланс перед чтением', async () => {
    const client = { tag: 'secure-client', account: { wallet: OUR_ADDRESS } } as unknown as BaseSecureClient;
    const calls: { client: BaseSecureClient; request: UpdateBalanceAllowanceRequest }[] = [];
    const assetTypes = {
      COLLATERAL: 'COLLATERAL' as UpdateBalanceAllowanceRequest['assetType'],
      CONDITIONAL: 'CONDITIONAL' as UpdateBalanceAllowanceRequest['assetType'],
    };
    const reader = PolymarketClobRefreshedBalanceReader.fromSdk(client, {
      assetTypes,
      updateBalanceAllowance: (passedClient, request) => {
        calls.push({ client: passedClient, request });
        return Promise.resolve({ balance: '1000000', allowances: {} } as unknown as BalanceAllowanceResponse);
      },
    });

    const collateral = await reader.getCollateralBalance();
    const token = await reader.getOutcomeAssetBalance(YES);

    expect(collateral.ok && collateral.value.value().toString()).toBe('1');
    expect(token.ok && token.value.value().toString()).toBe('1');
    expect(calls).toEqual([
      { client, request: { assetType: assetTypes.COLLATERAL } },
      { client, request: { assetType: assetTypes.CONDITIONAL, tokenId: YES_TOKEN_ID } },
    ]);
  });

  it('boundWallet — кошелёк аутентифицированного клиента (client.account.wallet), а не конфигурация', () => {
    const client = { account: { wallet: OUR_ADDRESS } } as unknown as BaseSecureClient;
    const reader = PolymarketClobRefreshedBalanceReader.fromSdk(client, {
      assetTypes: {
        COLLATERAL: 'COLLATERAL' as UpdateBalanceAllowanceRequest['assetType'],
        CONDITIONAL: 'CONDITIONAL' as UpdateBalanceAllowanceRequest['assetType'],
      },
      updateBalanceAllowance: () => Promise.reject(new Error('not called')),
    });
    expect(reader.boundWallet).toBe(OUR_ADDRESS);
  });
});

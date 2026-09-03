/**
 * Раскрытие CexPolicy в логические claim-ы и оценка окна НА `now`.
 *
 * @remarks
 * Два разных вопроса, которые здесь и разводятся:
 *
 * ```text
 * Polymarket: подойдёт ли policy в момент СТАРТА рынка
 * CEX:        нужен ли этому владельцу поток ПРЯМО СЕЙЧАС
 * ```
 *
 * Полуоткрытая семантика `PolicyWindow` при этом обязана сохраниться
 * целиком: стык двух policy принадлежит следующей.
 */
import { describe, it, expect } from '@jest/globals';
import { CexSubscriptionController } from '../src/index.js';
import type { CexSubscriptionClaim } from '../src/index.js';
import type { CexMarketType } from '@polymarket/cex-v2';
import type { CexPolicyMarketType } from '@polymarket/policy';
import {
  AT_1757_MS,
  AT_1759_59_999_MS,
  AT_1800_MS,
  CapturingLogger,
  policy,
  sourceFactoryProbe,
  ts,
} from './helpers/fakes.js';

function makeController(): {
  controller: CexSubscriptionController;
  probe: ReturnType<typeof sourceFactoryProbe>;
} {
  const probe = sourceFactoryProbe();
  const controller = new CexSubscriptionController({
    sourceFactory: probe.factory,
    logger: new CapturingLogger(),
  });
  return { controller, probe };
}

/** Компактная запись claim-а для сравнений. */
function label(claim: CexSubscriptionClaim): string {
  return `${claim.ownerKey}|${claim.exchangeId}|${claim.marketType}|${claim.symbol}|${claim.stream}`;
}

describe('декартово произведение policy', () => {
  it('exchangeIds × marketTypes × symbols × потоки', async () => {
    const { controller } = makeController();

    await controller.reconcile(
      [
        {
          ownerKey: 'A',
          policy: policy({
            exchangeIds: ['binance', 'kraken'],
            marketTypes: ['spot', 'swap'],
            symbols: ['BTC/USDT', 'ETH/USDT'],
            orderbook: true,
            trades: true,
          }),
        },
      ],
      ts(AT_1800_MS),
    );

    // 2 биржи × 2 типа рынка × 2 символа × 2 потока
    expect(controller.listClaims()).toHaveLength(16);
    // 2 биржи × 2 типа рынка × 2 потока
    expect(controller.getStats().desiredPools).toBe(8);
  });

  it('повторы внутри одной policy схлопываются: identity claim-а, а не позиция', async () => {
    const { controller } = makeController();

    await controller.reconcile(
      [
        {
          ownerKey: 'A',
          policy: policy({
            exchangeIds: ['binance', 'binance'],
            symbols: ['BTC/USDT', 'BTC/USDT'],
          }),
        },
      ],
      ts(AT_1800_MS),
    );

    expect(controller.listClaims().map(label)).toEqual(['A|binance|swap|BTC/USDT|TRADES']);
  });

  it('claim стакана несёт желаемую глубину, claim сделок — нет', async () => {
    const { controller } = makeController();

    await controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ orderbook: true, trades: true, orderbookDepth: 25 }) }],
      ts(AT_1800_MS),
    );

    const claims = controller.listClaims();
    expect(claims.find((claim) => claim.stream === 'ORDERBOOK')?.desiredDepth).toBe(25);
    expect(claims.find((claim) => claim.stream === 'TRADES')?.desiredDepth).toBeUndefined();
  });

  it('без orderbookDepth берётся DEFAULT_ORDERBOOK_DEPTH транспорта', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ orderbook: true, trades: false }) }],
      ts(AT_1800_MS),
    );

    expect(probe.configs[0]?.orderbookDepth).toBe(10);
  });
});

describe('окно policy оценивается на now', () => {
  it('policy ещё не действует: спрос есть, claim-ов нет', async () => {
    const { controller, probe } = makeController();

    const result = await controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ effectiveFrom: ts(AT_1800_MS) }) }],
      ts(AT_1757_MS),
    );

    expect(result.activeDemands).toBe(0);
    expect(result.inactiveDemands).toBe(1);
    expect(controller.listClaims()).toEqual([]);
    expect(probe.sources).toHaveLength(0);
  });

  it('в момент effectiveFrom claim материализуется и источник стартует', async () => {
    const { controller, probe } = makeController();
    const demands = [{ ownerKey: 'A', policy: policy({ effectiveFrom: ts(AT_1800_MS) }) }];

    await controller.reconcile(demands, ts(AT_1757_MS));
    const result = await controller.reconcile(demands, ts(AT_1800_MS));

    expect(result.activeDemands).toBe(1);
    expect(result.openedPools).toEqual(['binance|swap|TRADES']);
    expect(probe.sources).toHaveLength(1);
    expect(probe.sources[0]?.startCalls).toBe(1);
  });

  it('effectiveUntil исключён: 17:59:59.999 держим, 18:00:00.000 закрываем', async () => {
    const { controller, probe } = makeController();
    const demands = [{ ownerKey: 'A', policy: policy({ effectiveUntil: ts(AT_1800_MS) }) }];

    const before = await controller.reconcile(demands, ts(AT_1759_59_999_MS));
    expect(before.openedPools).toEqual(['binance|swap|TRADES']);

    const at = await controller.reconcile(demands, ts(AT_1800_MS));
    expect(at.activeDemands).toBe(0);
    expect(at.closedPools).toEqual(['binance|swap|TRADES']);
    expect(probe.sources[0]?.closeCalls).toBe(1);
    expect(controller.getStats().physicalPools).toBe(0);
  });

  it('смена policy на стыке окна: два прохода одного владельца', async () => {
    const { controller, probe } = makeController();

    // Дубликат ownerKey в одном проходе запрещён, поэтому composition root
    // подаёт на каждый тик ровно одну текущую policy владельца.
    await controller.reconcile(
      [
        {
          ownerKey: 'A',
          policy: policy({ symbols: ['BTC/USDT'], effectiveUntil: ts(AT_1800_MS) }),
        },
      ],
      ts(AT_1759_59_999_MS),
    );
    const after = await controller.reconcile(
      [
        {
          ownerKey: 'A',
          policy: policy({ symbols: ['XRP/USDT'], effectiveFrom: ts(AT_1800_MS) }),
        },
      ],
      ts(AT_1800_MS),
    );

    expect(after.replacedPools).toEqual(['binance|swap|TRADES']);
    expect(controller.listClaims().map((claim) => claim.symbol)).toEqual(['XRP/USDT']);
    expect(probe.configs.at(-1)?.symbols).toEqual(['XRP/USDT']);
  });
});

describe('словари типа рынка не разошлись', () => {
  it('CexPolicyMarketType и CexMarketType взаимно присваиваемы', () => {
    // Проверка КОМПИЛЯЦИИ, а не рантайма: контроллер присваивает тип рынка
    // policy напрямую в спецификацию пула, и расхождение словаря
    // Application со словарём транспорта обязано стать ошибкой типов —
    // здесь и в `_expandPolicy`, а не молчаливым несовпадением строк в
    // конфигурации источника.
    const fromPolicy: CexMarketType = 'swap' as CexPolicyMarketType;
    const fromTransport: CexPolicyMarketType = 'swap' as CexMarketType;

    expect([fromPolicy, fromTransport]).toEqual(['swap', 'swap']);
  });
});

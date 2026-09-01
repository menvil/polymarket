/**
 * Поведенческие тесты технического классификатора семейства `CRYPTO_UP_DOWN`.
 *
 * @remarks
 * Классификатор — единственное место, решающее «ведём ли мы этот рынок».
 * Ошибка в любую сторону дорога: ложноположительная тащит чужой рынок в
 * realtime-контур, ложноотрицательная молча теряет нашу серию. Поэтому обе
 * поддержанные vendor-формы и все три исхода классификации проверяются
 * явно, включая соседей по окну `endDate` (спорт, погода, политика) и
 * крипто-рынок общего вида.
 */
import { describe, it, expect } from '@jest/globals';
import { classifyPolymarketMarket, isSupportedCryptoUpDown } from '../src/index.js';
import {
  CONDITION_ID_BTC,
  CONDITION_ID_ETH,
  CONDITION_ID_SOL,
  CONDITION_ID_XRP,
  FIXED_NOW_MS,
  TOKEN_ID_BTC_DOWN,
  TOKEN_ID_BTC_UP,
  createCryptoThresholdMarket,
  createCryptoUpDownMarket,
  createFootballMarket,
  createPoliticsMarket,
  createSdkMarket,
  createWeatherMarket,
} from './helpers/gammaFixtures.js';

describe('поддержанное семейство: crypto Up/Down (TEST 1)', () => {
  const SERIES: ReadonlyArray<['btc' | 'eth' | 'sol' | 'xrp', string]> = [
    ['btc', CONDITION_ID_BTC],
    ['eth', CONDITION_ID_ETH],
    ['sol', CONDITION_ID_SOL],
    ['xrp', CONDITION_ID_XRP],
  ];

  it.each(SERIES)('%s Up/Down распознаётся как CRYPTO_UP_DOWN', (asset, conditionId) => {
    const result = classifyPolymarketMarket(createCryptoUpDownMarket(asset, { conditionId }));

    expect(result.kind).toBe('CRYPTO_UP_DOWN');
    if (result.kind !== 'CRYPTO_UP_DOWN') return;
    expect(result.crypto.asset).toBe(asset);
    expect(result.semantics).toBe('outcome-pair');
    expect(String(result.marketId)).toBe(conditionId);
  });

  it('извлекает canonical поля рынка одним проходом', () => {
    const result = classifyPolymarketMarket(createSdkMarket());

    expect(result.kind).toBe('CRYPTO_UP_DOWN');
    if (result.kind !== 'CRYPTO_UP_DOWN') return;
    expect(result.question).toBe('Bitcoin Up or Down - August 19, 8AM ET');
    expect(result.slug).toBe('bitcoin-up-or-down-august-19-8am-et');
    expect(result.expiresAt.toNumber()).toBe(FIXED_NOW_MS + 30 * 60_000);
    expect(result.outcomes).toEqual([
      { index: 0, label: 'Up', instrumentId: TOKEN_ID_BTC_UP },
      { index: 1, label: 'Down', instrumentId: TOKEN_ID_BTC_DOWN },
    ]);
  });

  it('пара Up/Down распознаётся в ЛЮБОМ vendor-порядке, индексы сохраняют порядок площадки', () => {
    const result = classifyPolymarketMarket(
      createSdkMarket({ yesLabel: 'Down', noLabel: 'Up' }),
    );

    expect(result.kind).toBe('CRYPTO_UP_DOWN');
    if (result.kind !== 'CRYPTO_UP_DOWN') return;
    // Down пришёл первым — он и остаётся index 0: realtime адресуется тем же порядком
    expect(result.outcomes[0]).toEqual({
      index: 0,
      label: 'Down',
      instrumentId: TOKEN_ID_BTC_UP,
    });
    expect(result.outcomes[1]!.label).toBe('Up');
  });

  it('метки нечувствительны к регистру и обрезаются', () => {
    const result = classifyPolymarketMarket(
      createSdkMarket({ yesLabel: ' UP ', noLabel: 'down' }),
    );

    expect(result.kind).toBe('CRYPTO_UP_DOWN');
    if (result.kind !== 'CRYPTO_UP_DOWN') return;
    expect(result.outcomes.map((outcome) => outcome.label)).toEqual(['UP', 'down']);
  });

  it('форма Yes/No принимается ТОЛЬКО с явной фразой «Up or Down» в вопросе', () => {
    const result = classifyPolymarketMarket(
      createSdkMarket({
        yesLabel: 'Yes',
        noLabel: 'No',
        question: 'Bitcoin Up or Down — 6:30PM ET?',
      }),
    );

    expect(result.kind).toBe('CRYPTO_UP_DOWN');
    if (result.kind !== 'CRYPTO_UP_DOWN') return;
    expect(result.semantics).toBe('question-phrase');
  });

  it('фраза «Up or Down» распознаётся и в groupItemTitle', () => {
    const result = classifyPolymarketMarket(
      createSdkMarket({
        yesLabel: 'Yes',
        noLabel: 'No',
        question: 'Bitcoin — 6:30PM ET?',
        groupItemTitle: 'Bitcoin Up or Down',
      }),
    );

    expect(result.kind).toBe('CRYPTO_UP_DOWN');
    if (result.kind !== 'CRYPTO_UP_DOWN') return;
    expect(result.semantics).toBe('question-phrase');
  });

  it('isSupportedCryptoUpDown — тонкий предикат над той же классификацией', () => {
    expect(isSupportedCryptoUpDown(createSdkMarket())).toBe(true);
    expect(isSupportedCryptoUpDown(createFootballMarket())).toBe(false);
  });
});

describe('неподдержанные семейства (TEST 2)', () => {
  it.each([
    ['football', createFootballMarket()],
    ['weather', createWeatherMarket()],
    ['politics', createPoliticsMarket()],
  ])('%s → UNSUPPORTED (not-crypto)', (_name, market) => {
    expect(classifyPolymarketMarket(market)).toEqual({
      kind: 'UNSUPPORTED',
      reason: 'not-crypto',
    });
  });

  it('крипто-рынок общего вида (Yes/No, порог цены) → UNSUPPORTED (not-up-down)', () => {
    expect(classifyPolymarketMarket(createCryptoThresholdMarket())).toEqual({
      kind: 'UNSUPPORTED',
      reason: 'not-up-down',
    });
  });

  it('крипто Yes/No без фразы «Up or Down» не принимается даже при слове up в тексте', () => {
    const result = classifyPolymarketMarket(
      createSdkMarket({
        yesLabel: 'Yes',
        noLabel: 'No',
        question: 'Will Bitcoin close up on August 19?',
      }),
    );

    expect(result).toEqual({ kind: 'UNSUPPORTED', reason: 'not-up-down' });
  });

  it('нелатинская буква вплотную к фразе — тоже граница слова, а не пунктуация', () => {
    // ASCII-границы `[a-zA-Z0-9]` считали бы «Биткоинup» разрывом слова и
    // пропускали чужой рынок в realtime-контур
    const result = classifyPolymarketMarket(
      createSdkMarket({
        yesLabel: 'Yes',
        noLabel: 'No',
        question: 'Биткоинup or down?',
      }),
    );

    expect(result).toEqual({ kind: 'UNSUPPORTED', reason: 'not-up-down' });
  });

  it('нет fuzzy-матчинга: «Groupon or Downtown» не считается Up/Down', () => {
    const result = classifyPolymarketMarket(
      createSdkMarket({
        yesLabel: 'Yes',
        noLabel: 'No',
        question: 'Will Groupon or Downtown Inc. announce a merger?',
      }),
    );

    expect(result).toEqual({ kind: 'UNSUPPORTED', reason: 'not-up-down' });
  });

  it('чужая пара меток крипто-рынка (Over/Under) не считается Up/Down', () => {
    const result = classifyPolymarketMarket(
      createSdkMarket({ yesLabel: 'Over', noLabel: 'Under' }),
    );

    expect(result).toEqual({ kind: 'UNSUPPORTED', reason: 'not-up-down' });
  });

  it('крипто-пара без Binance-маппинга не поддержана как крипто-рынок', () => {
    const result = classifyPolymarketMarket(
      createSdkMarket({
        resolutionSource: 'https://data.chain.link/streams/hype-usd-twap-60s-streams',
      }),
    );

    expect(result).toEqual({ kind: 'UNSUPPORTED', reason: 'not-crypto' });
  });
});

describe('непригодные рынки НАШЕГО семейства (TEST 3)', () => {
  it('malformed binary: оба исхода несут один и тот же инструмент', () => {
    const result = classifyPolymarketMarket(
      createSdkMarket({ noTokenId: TOKEN_ID_BTC_UP }),
    );

    expect(result).toEqual({ kind: 'INVALID', reason: 'outcome-identity' });
  });

  it('missing instrument id: у второго исхода нет CLOB-токена', () => {
    expect(classifyPolymarketMarket(createSdkMarket({ noTokenId: null }))).toEqual({
      kind: 'INVALID',
      reason: 'outcome-instrument',
    });
  });

  it('missing instrument id: токен не парсится в canonical InstrumentId', () => {
    expect(classifyPolymarketMarket(createSdkMarket({ yesTokenId: '   ' }))).toEqual({
      kind: 'INVALID',
      reason: 'outcome-instrument',
    });
  });

  it('missing question: вопроса нет, семантику подтвердили метки', () => {
    expect(classifyPolymarketMarket(createSdkMarket({ question: null }))).toEqual({
      kind: 'INVALID',
      reason: 'question',
    });
  });

  it('invalid expiration: endDate не парсится', () => {
    expect(classifyPolymarketMarket(createSdkMarket({ endDate: 'not-a-date' }))).toEqual({
      kind: 'INVALID',
      reason: 'expiry',
    });
  });

  it('invalid expiration: endDate отсутствует', () => {
    expect(classifyPolymarketMarket(createSdkMarket({ endDate: null }))).toEqual({
      kind: 'INVALID',
      reason: 'expiry',
    });
  });

  it('нет conditionId → нет canonical MarketId', () => {
    expect(classifyPolymarketMarket(createSdkMarket({ conditionId: null }))).toEqual({
      kind: 'INVALID',
      reason: 'market-id',
    });
  });

  it('неканонический slug не делает рынок непригодным — поля просто нет', () => {
    const result = classifyPolymarketMarket(createSdkMarket({ slug: 'Not A Slug!' }));

    expect(result.kind).toBe('CRYPTO_UP_DOWN');
    if (result.kind !== 'CRYPTO_UP_DOWN') return;
    expect(result.slug).toBeUndefined();
  });
});

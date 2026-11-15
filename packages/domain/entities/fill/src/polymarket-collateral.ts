/**
 * Денежный collateral Polymarket CLOB V2 — единственное объявление.
 *
 * @remarks
 * Polymarket CLOB V2 торгует и рассчитывается в **pUSD** (Polymarket USD), а
 * не в USDC. Подтверждено тремя независимыми источниками:
 *
 * ```text
 * официальный SDK   @polymarket/client 0.6.0, production (chainId 137):
 *                   environment.contracts.collateralToken =
 *                   0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB
 * документация      docs.polymarket.com/resources/contracts:
 *                   «pUSD — CollateralToken Poly v2» = тот же адрес;
 *                   concepts/pusd: «collateral token used for all trading», 6 decimals;
 *                   migrate/polymarket-v2: balance-allowance `COLLATERAL` selects pUSD
 * контракт on-chain symbol() = "pUSD", name() = "Polymarket USD", decimals() = 6
 * ```
 *
 * pUSD — ERC-20, обеспеченный USDC, но это ДРУГОЙ токен. Поэтому деньги
 * Polymarket-аккаунта (collateral-баланс, расчёт и комиссия исполнения)
 * выражаются в canonical валюте `pUSD`, а не в `USDC`, и никакого курса
 * pUSD ↔ USDC в домене нет: смешение валют отвергают `MoneyService`,
 * `BalanceService` и `Portfolio`.
 *
 * Обе стороны Polymarket-аккаунта берут валюту ОТСЮДА:
 *
 * ```text
 * REST баланс collateral   collateralFromBaseUnits()        → Money(…, pUSD)
 * Fill приватного WS/REST  FillMapper (settlement, fee)     → CURRENCY:pUSD
 * комиссия TAKER           calculatePolymarketTakerFee*()   → Fee в pUSD
 * ```
 *
 * Иначе один путь мог бы остаться на USDC, а другой перейти на pUSD — и
 * портфель отверг бы собственные исполнения или, хуже, принял бы чужую
 * валюту за свою.
 *
 * Базовые единицы баланса (6 знаков) — забота адаптера площадки
 * (`@polymarket/polymarket-v2`), а не этого модуля: `Fill` с базовыми
 * единицами не работает.
 *
 * @packageDocumentation
 */
import { AssetIdHelpers, KnownCurrencies, type AssetId } from '@polymarket/ids';

/**
 * Canonical валюта денег Polymarket CLOB V2 — `'pUSD'`.
 *
 * @remarks
 * Валюта collateral-баланса Polymarket-аккаунта и, значит, его `Portfolio`.
 * Тип — литерал `'pUSD'`, а не просто `SupportedCurrency`: подменить её на
 * USDC молча нельзя даже на уровне типов.
 *
 * @example
 * ```typescript
 * import { MoneyService } from '@polymarket/value-objects';
 * import { POLYMARKET_COLLATERAL_CURRENCY } from '@polymarket/fill';
 *
 * const balance = MoneyService.create('100', POLYMARKET_COLLATERAL_CURRENCY); // Ok(Money 100 pUSD)
 * ```
 */
export const POLYMARKET_COLLATERAL_CURRENCY = KnownCurrencies.pUSD;

/**
 * Canonical актив денег Polymarket CLOB V2 — `CURRENCY:pUSD`.
 *
 * @remarks
 * `Fill.settlementAssetId` и актив комиссии любого Polymarket-исполнения,
 * пришло ли оно приватным WS или REST: факт исполнения один
 * (`findFillFactDifference`), и актив расчёта входит в него.
 *
 * @example
 * ```typescript
 * import { assetIdToString } from '@polymarket/ids';
 * import { POLYMARKET_COLLATERAL_ASSET_ID } from '@polymarket/fill';
 *
 * assetIdToString(POLYMARKET_COLLATERAL_ASSET_ID); // 'CURRENCY:pUSD'
 * ```
 */
export const POLYMARKET_COLLATERAL_ASSET_ID: AssetId = AssetIdHelpers.PUSD;

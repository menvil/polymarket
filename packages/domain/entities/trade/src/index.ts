/**
 * @polymarket/trade - Trade entity (market print)
 *
 * @remarks
 * Экспортирует Trade entity и связанные типы.
 *
 * Trade представляет рыночный принт (market print):
 * факт исполнения сделки на торговой площадке.
 *
 * Используется для:
 * - Аналитики рынка (VWAP, давление, объём)
 * - Построения сигналов
 * - Ведения рыночной ленты (market tape)
 *
 * @packageDocumentation
 */

export { Trade } from './Trade.js';
export type { TradeParams } from './Trade.js';
export type { TradeSnapshot } from './TradeSnapshot.js';
export { TradeMapper } from './mappers/TradeMapper.js';

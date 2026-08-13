/**
 * PolymarketMessageFormatter — форматирует исходящие WebSocket-сообщения Polymarket
 *
 * @remarks
 * Отвечает за форматирование ИСХОДЯЩИХ сообщений subscribe/unsubscribe в формате Polymarket.
 * Это ИСХОДЯЩАЯ половина transport слоя. Входящие сообщения парсит
 * PolymarketMessageRouter внутри PolymarketWsAdapter.
 *
 * Формат подписки Polymarket:
 * ```json
 * {
 *   "assets_ids": ["67704255...", "28257334..."],
 *   "type": "market"
 * }
 * ```
 *
 * Ключевые обязанности:
 * - Преобразование SubscriptionParams в формат Polymarket JSON
 * - Валидация token ID (должны быть числовыми строками)
 * - Удаление дублирующихся token ID
 * - Логирование предупреждений для подозрительного ввода
 *
 * Правила валидации:
 * - Для `type=user`: assets_ids не нужен, используется поле `auth`
 * - Для `type=market`: assets_ids обязателен и не должен быть пустым
 * - Token ID должны быть числовыми строками (77 цифр)
 * - Дубликаты удаляются автоматически
 * - Невалидные токены логируются, но не отклоняются (пусть биржа проверяет)
 *
 * @example
 * ```typescript
 * const formatter = new PolymarketMessageFormatter(logger);
 *
 * const message = formatter.formatSubscription('market', {
 *   assets_ids: ['67704255...', '28257334...', '67704255...'], // дубликат
 *   type: 'market',
 * });
 *
 * console.log(message);
 * // {"assets_ids":["67704255...","28257334..."],"type":"market"}
 * // Примечание: дубликат удалён
 * ```
 *
 * @module infrastructure/polymarket/ws/PolymarketMessageFormatter
 */

import type { IMessageFormatter } from '../stubs/shared/websocket/IMessageFormatter.js';
import type { SubscriptionParams } from '../stubs/shared/websocket/types.js';
import type { PolymarketSubscriptionParams } from './types.js';
import type { ILogger } from '@polymarket/logger';

/**
 * Реализация форматтера сообщений Polymarket
 *
 * @remarks
 * Реализует IMessageFormatter для WebSocket API Polymarket CLOB.
 *
 * Возможности:
 * - Удаление дублирующихся токенов
 * - Валидация формата токенов
 * - Подробное логирование для отладки
 *
 * Обработка ошибок:
 * - Бросает Error при отсутствующем/пустом assets_ids
 * - Логирует предупреждения при невалидном формате токена (но не бросает)
 * - Никогда не возвращает null/undefined (всегда бросает или возвращает валидную строку)
 */
export class PolymarketMessageFormatter implements IMessageFormatter {
  private readonly logger: ILogger;

  /**
   * Создаёт новый форматтер сообщений Polymarket
   *
   * @param logger - Экземпляр logger
   *
   * @throws {Error} Если logger равен null
   *
   * @example
   * ```typescript
   * const formatter = new PolymarketMessageFormatter(logger);
   * ```
   */
  constructor(logger: ILogger) {
    if (!logger) {
      throw new Error('logger is required');
    }

    this.logger = logger.child({ component: 'PolymarketMessageFormatter' });
  }

  /**
   * Форматирует сообщение подписки Polymarket
   *
   * @param channel - Имя канала (игнорируется Polymarket)
   * @param params - Параметры подписки
   * @returns JSON-строка, готовая к отправке через WebSocket
   * @throws {Error} Если assets_ids отсутствует или пуст
   *
   * @remarks
   * Polymarket не использует параметр channel — только assets_ids и type.
   *
   * Алгоритм:
   * 1. Привести params к PolymarketSubscriptionParams
   * 2. Проверить наличие и непустоту assets_ids
   * 3. Удалить дублирующиеся token ID
   * 4. Проверить формат токенов (числовые строки)
   * 5. Сформировать объект подписки
   * 6. Вернуть JSON.stringify()
   *
   * Валидация:
   * - assets_ids должен присутствовать → бросает Error
   * - assets_ids не должен быть пустым → бросает Error
   * - Token ID должны быть числовыми строками → логирует предупреждение если нет
   *
   * Удаление дублей:
   * - Использует Set для удаления дубликатов
   * - Логирует предупреждение при обнаружении дублей
   *
   * @example
   * ```typescript
   * // Валидная подписка
   * const msg = formatter.formatSubscription('market', {
   *   assets_ids: ['67704255...', '28257334...'],
   *   type: 'market',
   * });
   * // Возвращает: '{"assets_ids":["67704255...","28257334..."],"type":"market"}'
   *
   * // Удаление дублей
   * const msg = formatter.formatSubscription('market', {
   *   assets_ids: ['67704255...', '67704255...'],
   *   type: 'market',
   * });
   * // Возвращает: '{"assets_ids":["67704255..."],"type":"market"}'
   * // Логирует: ⚠️  Duplicate tokens detected
   *
   * // Отсутствующий assets_ids (бросает)
   * const msg = formatter.formatSubscription('market', {});
   * // Бросает: Error('assets_ids is required')
   * ```
   */
  formatSubscription(_channel: string, params: SubscriptionParams): string {
    const polyParams = params as Partial<PolymarketSubscriptionParams> & { auth?: unknown };

    // ── User channel: { type: 'user', auth: { apiKey, secret, passphrase } } ──
    // Не требует assets_ids — аутентифицируется через HMAC подпись.
    if (polyParams.type === 'user') {
      const subscription = { type: 'user', auth: polyParams.auth };
      const json = JSON.stringify(subscription);
      this.logger.debug('Formatting Polymarket user channel subscription');
      return json;
    }

    // ── Market channel: { type: 'market', assets_ids: [...] } ─────────────────

    if (!polyParams.assets_ids || polyParams.assets_ids.length === 0) {
      this.logger.error('assets_ids is required for Polymarket subscription', { params });
      throw new Error('assets_ids is required and must not be empty');
    }

    // Удаляем дубликаты
    const uniqueTokens = [...new Set(polyParams.assets_ids)];

    if (uniqueTokens.length !== polyParams.assets_ids.length) {
      const duplicateCount = polyParams.assets_ids.length - uniqueTokens.length;
      this.logger.warn('⚠️  Duplicate tokens detected in subscription!', {
        original: polyParams.assets_ids.length,
        unique: uniqueTokens.length,
        duplicates: duplicateCount,
      });
    }

    // Проверяем формат токенов (должны быть числовые строки)
    const invalidTokens = uniqueTokens.filter(t => !/^\d+$/.test(t));
    if (invalidTokens.length > 0) {
      this.logger.error('❌ Invalid token format detected!', {
        invalidCount: invalidTokens.length,
        examples: invalidTokens.slice(0, 3),
        hint: 'Tokens must be numeric strings (e.g., "67704255197116168826604911233626301865010283966205730455742704536521111535950")',
      });
    }

    // Формируем формат подписки Polymarket
    const subscription = {
      assets_ids: uniqueTokens,
      type: polyParams.type || 'market',
    };

    const subscriptionJson = JSON.stringify(subscription);

    this.logger.info('📡 Formatting Polymarket subscription', {
      tokenCount: uniqueTokens.length,
      tokens: uniqueTokens.map(t => t.substring(0, 16) + '...'),
      fullTokens: uniqueTokens,
      type: subscription.type,
      jsonLength: subscriptionJson.length,
      jsonPreview: subscriptionJson.substring(0, 500) + (subscriptionJson.length > 500 ? '...' : ''),
    });

    return subscriptionJson;
  }

  /**
   * Форматирует сообщение отписки Polymarket
   *
   * @param channel - Имя канала (игнорируется Polymarket)
   * @param params - Параметры отписки
   * @returns JSON-строка, готовая к отправке через WebSocket
   * @throws {Error} Если assets_ids отсутствует или пуст
   *
   * @remarks
   * Polymarket использует ОДИНАКОВЫЙ формат для подписки и отписки.
   * Биржа определяет операцию на основе текущего состояния подписки.
   *
   * Этот метод просто делегирует вызов к formatSubscription().
   *
   * @example
   * ```typescript
   * const msg = formatter.formatUnsubscription('market', {
   *   assets_ids: ['67704255...'],
   *   type: 'market',
   * });
   * // Возвращает: '{"assets_ids":["67704255..."],"type":"market"}'
   * ```
   */
  formatUnsubscription(channel: string, params: SubscriptionParams): string {
    // Polymarket использует одинаковый формат для подписки и отписки
    this.logger.debug('Formatting Polymarket unsubscription (same as subscription)', { params });
    return this.formatSubscription(channel, params);
  }
}

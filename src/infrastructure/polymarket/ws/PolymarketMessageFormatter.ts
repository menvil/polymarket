/**
 * PolymarketMessageFormatter - Форматирует исходящие WebSocket сообщения для Polymarket
 *
 * @remarks
 * Отвечает за форматирование ИСХОДЯЩИХ сообщений subscribe/unsubscribe в формате Polymarket.
 * Это ИСХОДЯЩАЯ половина (в паре с PolymarketMessageParser для входящих).
 *
 * Формат подписки Polymarket:
 * ```json
 * {
 *   "assets_ids": ["67704255...", "28257334..."],
 *   "type": "market"
 * }
 * ```
 *
 * Основные обязанности:
 * - Конвертировать SubscriptionParams в JSON формат Polymarket
 * - Валидировать ID токенов (должны быть числовыми строками)
 * - Удалять дубликаты ID токенов
 * - Логировать предупреждения для подозрительного ввода
 *
 * Правила валидации:
 * - assets_ids обязателен и не должен быть пустым
 * - ID токенов должны быть числовыми строками (77 цифр)
 * - Дубликаты автоматически удаляются
 * - Невалидные токены логируются но не отклоняются (биржа сама валидирует)
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
 * // Примечание: дубликат удален
 * ```
 *
 * @module infrastructure/polymarket/ws/PolymarketMessageFormatter
 */

import type { IMessageFormatter } from '../../../shared/websocket/IMessageFormatter.js';
import type { SubscriptionParams } from '../../../shared/websocket/types.js';
import type { PolymarketSubscriptionParams } from './types.js';
import type { ILogger } from '../../../domain/ports/ILogger.js';

/**
 * Реализация форматтера сообщений Polymarket
 *
 * @remarks
 * Реализует IMessageFormatter для Polymarket CLOB WebSocket API.
 *
 * Возможности:
 * - Удаление дубликатов токенов
 * - Валидация формата токенов
 * - Детальное логирование для отладки
 *
 * Обработка ошибок:
 * - Бросает Error для отсутствующего/пустого assets_ids
 * - Логирует предупреждения для невалидных форматов токенов (но не бросает исключение)
 * - Никогда не возвращает null/undefined (всегда бросает исключение или возвращает валидную строку)
 */
export class PolymarketMessageFormatter implements IMessageFormatter {
  private readonly logger: ILogger;

  /**
   * Создает новый форматтер сообщений Polymarket
   *
   * @param logger - Экземпляр логгера
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

    this.logger = logger.child ? logger.child('PolymarketMessageFormatter') : logger;
  }

  /**
   * Форматирует сообщение подписки Polymarket
   *
   * @param channel - Имя канала (игнорируется Polymarket)
   * @param params - Параметры подписки
   * @returns JSON строка готовая для отправки через WebSocket
   * @throws {Error} Если assets_ids отсутствует или пуст
   *
   * @remarks
   * Polymarket не использует параметр channel - он смотрит только на assets_ids и type.
   *
   * Алгоритм:
   * 1. Привести params к типу PolymarketSubscriptionParams
   * 2. Валидировать что assets_ids существует и не пустой
   * 3. Удалить дубликаты ID токенов
   * 4. Валидировать формат токенов (числовые строки)
   * 5. Построить объект подписки
   * 6. Вернуть JSON.stringify()
   *
   * Валидация:
   * - assets_ids должен существовать → бросает Error
   * - assets_ids не должен быть пустым → бросает Error
   * - ID токенов должны быть числовыми строками → логирует предупреждение если нет
   *
   * Удаление дубликатов:
   * - Использует Set для удаления дубликатов
   * - Логирует предупреждение если обнаружены дубликаты
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
   * // Удаление дубликатов
   * const msg = formatter.formatSubscription('market', {
   *   assets_ids: ['67704255...', '67704255...'],
   *   type: 'market',
   * });
   * // Возвращает: '{"assets_ids":["67704255..."],"type":"market"}'
   * // Логирует: ⚠️  Duplicate tokens detected
   *
   * // Отсутствующий assets_ids (бросает исключение)
   * const msg = formatter.formatSubscription('market', {});
   * // Бросает: Error('assets_ids is required')
   * ```
   */
  formatSubscription(_channel: string, params: SubscriptionParams): string {
    const polyParams = params as Partial<PolymarketSubscriptionParams>;

    // Валидируем обязательные поля
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

    // Валидируем формат токенов (должны быть числовыми строками)
    const invalidTokens = uniqueTokens.filter(t => !/^\d+$/.test(t));
    if (invalidTokens.length > 0) {
      this.logger.error('❌ Invalid token format detected!', {
        invalidCount: invalidTokens.length,
        examples: invalidTokens.slice(0, 3),
        hint: 'Tokens must be numeric strings (e.g., "67704255197116168826604911233626301865010283966205730455742704536521111535950")',
      });
    }

    // Строим формат подписки Polymarket
    const subscription = {
      assets_ids: uniqueTokens,
      type: polyParams.type || 'market',
    };

    const subscriptionJson = JSON.stringify(subscription);

    // Логируем детали подписки
    this.logger.info('📡 Formatting Polymarket subscription', {
      tokenCount: uniqueTokens.length,
      tokens: uniqueTokens.map(t => t.substring(0, 16) + '...'),
      fullTokens: uniqueTokens, // Полные токены для отладки
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
   * @returns JSON строка готовая для отправки через WebSocket
   * @throws {Error} Если assets_ids отсутствует или пуст
   *
   * @remarks
   * Polymarket использует ОДИНАКОВЫЙ формат для subscribe и unsubscribe.
   * Биржа определяет операцию на основе текущего состояния подписки.
   *
   * Этот метод просто делегирует вызов formatSubscription().
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
    // Polymarket использует одинаковый формат для subscribe и unsubscribe
    this.logger.debug('Formatting Polymarket unsubscription (same as subscription)', { params });
    return this.formatSubscription(channel, params);
  }
}

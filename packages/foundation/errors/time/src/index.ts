/**
 * @module @polymarket/time
 * @description Утилиты для работы с временем и временными метками в Polymarket trading system
 *
 * @remarks
 * Модуль предоставляет абстракции для работы с временем через паттерн Dependency Injection.
 * Это обеспечивает детерминизм, тестируемость и возможность воспроизведения событий.
 *
 * ## Основные компоненты
 *
 * - **IClock**: интерфейс источника времени
 * - **LiveClock**: реализация на основе системного времени (production)
 * - **ReplayClock**: реализация с фиксированным временем (воспроизведение)
 * - **PaperClock**: реализация с управляемым временем (тестирование)
 *
 * ## Принципы использования
 *
 * Компоненты системы получают время через IClock, а не создают Date напрямую.
 * Это обеспечивает:
 * - Детерминированное поведение в разных режимах работы
 * - Возможность тестирования с контролируемым временем
 * - Точное воспроизведение исторических событий
 *
 * @example
 * Использование в production (LIVE режим):
 * ```typescript
 * import { LiveClock, type IClock } from '@polymarket/time';
 *
 * const clock: IClock = new LiveClock();
 * const currentTime = clock.now(); // Реальное системное время
 * ```
 *
 * @example
 * Использование в тестах (PAPER режим):
 * ```typescript
 * import { PaperClock } from '@polymarket/time';
 *
 * const clock = new PaperClock(new Date('2024-01-01'));
 * clock.tick(1000); // Продвинуть время на 1 секунду
 * const time = clock.now(); // 2024-01-01T00:00:01Z
 * ```
 *
 * @example
 * Использование при воспроизведении (REPLAY режим):
 * ```typescript
 * import { ReplayClock } from '@polymarket/time';
 *
 * const clock = new ReplayClock(new Date(0));
 *
 * for (const event of events) {
 *   clock.update(event.timestamp); // Обновить время из события
 *   processEvent(event); // Обработать с детерминированным временем
 * }
 * ```
 */

export type { IClock } from './IClock.js';
export { LiveClock } from './LiveClock.js';
export { PaperClock } from './PaperClock.js';
export { ReplayClock } from './ReplayClock.js';

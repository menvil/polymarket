import { QuoteService } from './dist/quote/facade/QuoteService.js';

// Создаем ошибку через nested call (bid > MAX_PRICE)
const result = QuoteService.create(1.5, 0.52, 100, 150);

if (!result.ok) {
  console.log('=== FULL CONTEXT (все поля сохранены!) ===');
  console.log(JSON.stringify(result.error.context, null, 2));
}

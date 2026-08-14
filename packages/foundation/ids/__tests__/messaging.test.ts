import { describe, it, expect } from '@jest/globals';
import {
  type MessageId,
  type RunId,
  asMessageId,
  asRunId,
  unsafeMessageId,
  unsafeRunId,
} from '../src/index.js';

describe('Messaging IDs', () => {
  describe('RunId', () => {
    it('принимает ровно 8 символов [a-z0-9]', () => {
      const valid: RunId | undefined = asRunId('k8f3pz7q');
      expect(valid).toBe('k8f3pz7q');

      expect(asRunId('00000000')).toBe('00000000');
      expect(asRunId('zzzzzzzz')).toBe('zzzzzzzz');
      expect(asRunId('a1b2c3d4')).toBe('a1b2c3d4');
    });

    it('отклоняет неверную длину', () => {
      expect(asRunId('')).toBeUndefined();
      expect(asRunId('k8f3pz7')).toBeUndefined(); // 7 символов
      expect(asRunId('k8f3pz7q1')).toBeUndefined(); // 9 символов
    });

    it('отклоняет недопустимые символы', () => {
      expect(asRunId('K8F3PZ7Q')).toBeUndefined(); // uppercase
      expect(asRunId('k8f3pz7_')).toBeUndefined(); // underscore
      expect(asRunId('k8f3pz7-')).toBeUndefined(); // dash
      expect(asRunId('k8f3pz7 ')).toBeUndefined(); // пробел
      expect(asRunId(' k8f3pz7')).toBeUndefined(); // ведущий пробел (без trim)
      expect(asRunId('k8f3p' + String.fromCharCode(0) + 'z7')).toBeUndefined(); // control char
    });

    it('отклоняет non-string runtime-ввод', () => {
      expect(asRunId(null as unknown as string)).toBeUndefined();
      expect(asRunId(undefined as unknown as string)).toBeUndefined();
      expect(asRunId(12345678 as unknown as string)).toBeUndefined();
    });

    it('unsafeRunId пропускает без валидации', () => {
      const raw = 'testrun1';
      const runId: RunId = unsafeRunId(raw);
      expect(runId).toBe(raw);
    });
  });

  describe('MessageId', () => {
    it('принимает канонический формат генератора', () => {
      const raw = 'k8f3pz7q-1786668087-123-456-789-000018423';
      const id: MessageId | undefined = asMessageId(raw);
      expect(id).toBe(raw);
    });

    it('identity opaque — принимает и другие непустые строки', () => {
      // MessageId сознательно не парсит компоненты — только branded-базовые правила
      expect(asMessageId('anything-goes')).toBe('anything-goes');
      expect(asMessageId('  trimmed  ')).toBe('trimmed');
    });

    it('отклоняет пустые и невалидные строки', () => {
      expect(asMessageId('')).toBeUndefined();
      expect(asMessageId('   ')).toBeUndefined();
      expect(asMessageId('a' + String.fromCharCode(0) + 'b')).toBeUndefined(); // control char
      expect(asMessageId('x'.repeat(200))).toBeUndefined(); // длиннее 128
    });

    it('unsafeMessageId пропускает без валидации', () => {
      const raw = 'fixture-message-id';
      const id: MessageId = unsafeMessageId(raw);
      expect(id).toBe(raw);
    });
  });
});

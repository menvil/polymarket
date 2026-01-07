/**
 * Bucket Type Registry Tests
 */

import { BucketTypeRegistry } from '../../../../../src/application/services/bucketizer/BucketTypeRegistry.js';
import type {
  IBucketType,
  Bucket,
} from '../../../../../src/application/services/bucketizer/types/bucket.js';
import type { DomainEvent } from '../../../../../src/domain/events/DomainEvent.js';

// Mock bucket type for testing
class MockBucketType implements IBucketType {
  constructor(private readonly name: string) {}

  getName(): string {
    return this.name;
  }

  getBucketKeys(_event: DomainEvent): string[] {
    return [];
  }

  createBucket(bucketKey: string): Bucket {
    return {
      bucketKey,
      bucketType: this.name,
      data: {},
    };
  }

  update(_bucket: Bucket, _event: DomainEvent): void {
    // No-op for tests
  }

  serialize(bucket: Bucket): string {
    return JSON.stringify(bucket);
  }

  deserialize(line: string): Bucket | null {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
}

describe('BucketTypeRegistry', () => {
  let registry: BucketTypeRegistry;

  beforeEach(() => {
    registry = new BucketTypeRegistry();
  });

  describe('register', () => {
    it('should register bucket type', () => {
      const bucketType = new MockBucketType('test_type');

      registry.register(bucketType);

      expect(registry.has('test_type')).toBe(true);
      expect(registry.get('test_type')).toBe(bucketType);
    });

    it('should register multiple bucket types', () => {
      const type1 = new MockBucketType('type1');
      const type2 = new MockBucketType('type2');
      const type3 = new MockBucketType('type3');

      registry.register(type1);
      registry.register(type2);
      registry.register(type3);

      expect(registry.size()).toBe(3);
      expect(registry.get('type1')).toBe(type1);
      expect(registry.get('type2')).toBe(type2);
      expect(registry.get('type3')).toBe(type3);
    });

    it('should throw if type already registered', () => {
      const type1 = new MockBucketType('duplicate');
      const type2 = new MockBucketType('duplicate');

      registry.register(type1);

      expect(() => registry.register(type2)).toThrow(
        "Bucket type 'duplicate' is already registered"
      );
    });
  });

  describe('get', () => {
    it('should return registered bucket type', () => {
      const bucketType = new MockBucketType('test');
      registry.register(bucketType);

      const result = registry.get('test');

      expect(result).toBe(bucketType);
    });

    it('should return null for unregistered type', () => {
      const result = registry.get('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('has', () => {
    it('should return true for registered type', () => {
      registry.register(new MockBucketType('exists'));

      expect(registry.has('exists')).toBe(true);
    });

    it('should return false for unregistered type', () => {
      expect(registry.has('nonexistent')).toBe(false);
    });
  });

  describe('getAll', () => {
    it('should return empty array initially', () => {
      const result = registry.getAll();

      expect(result).toEqual([]);
    });

    it('should return all registered types', () => {
      const type1 = new MockBucketType('type1');
      const type2 = new MockBucketType('type2');
      const type3 = new MockBucketType('type3');

      registry.register(type1);
      registry.register(type2);
      registry.register(type3);

      const result = registry.getAll();

      expect(result).toHaveLength(3);
      expect(result).toContain(type1);
      expect(result).toContain(type2);
      expect(result).toContain(type3);
    });

    it('should return new array (not internal reference)', () => {
      registry.register(new MockBucketType('test'));

      const result1 = registry.getAll();
      const result2 = registry.getAll();

      expect(result1).not.toBe(result2);
      expect(result1).toEqual(result2);
    });
  });

  describe('size', () => {
    it('should return 0 initially', () => {
      expect(registry.size()).toBe(0);
    });

    it('should return correct count', () => {
      registry.register(new MockBucketType('type1'));
      expect(registry.size()).toBe(1);

      registry.register(new MockBucketType('type2'));
      expect(registry.size()).toBe(2);

      registry.register(new MockBucketType('type3'));
      expect(registry.size()).toBe(3);
    });
  });

  describe('clear', () => {
    it('should remove all registered types', () => {
      registry.register(new MockBucketType('type1'));
      registry.register(new MockBucketType('type2'));

      expect(registry.size()).toBe(2);

      registry.clear();

      expect(registry.size()).toBe(0);
      expect(registry.has('type1')).toBe(false);
      expect(registry.has('type2')).toBe(false);
    });

    it('should allow re-registration after clear', () => {
      const type1 = new MockBucketType('test');
      registry.register(type1);

      registry.clear();

      const type2 = new MockBucketType('test');
      expect(() => registry.register(type2)).not.toThrow();

      expect(registry.get('test')).toBe(type2);
    });
  });
});

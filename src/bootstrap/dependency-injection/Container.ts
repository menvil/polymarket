/**
 * Dependency Injection Container
 * 
 * @remarks
 * Lightweight DI container for managing application dependencies.
 * Supports:
 * - Singleton registration
 * - Factory registration
 * - Transient registration
 * - Dependency resolution
 * 
 * Algorithm:
 * 1. Register dependencies with lifecycle (singleton/transient)
 * 2. Resolve dependencies recursively
 * 3. Cache singleton instances
 * 4. Return requested service
 * 
 * @example
 * ```typescript
 * const container = new Container();
 * 
 * // Register singleton
 * container.registerSingleton('config', () => new ConfigLoader());
 * 
 * // Register transient
 * container.registerTransient('logger', () => new ConsoleLogger());
 * 
 * // Resolve dependency
 * const config = container.resolve<ConfigLoader>('config');
 * ```
 */

type ServiceFactory<T = any> = () => T;
type ServiceLifecycle = 'singleton' | 'transient';

interface ServiceDescriptor<T = any> {
  factory: ServiceFactory<T>;
  lifecycle: ServiceLifecycle;
  instance?: T;
}

/**
 * Dependency Injection Container
 * 
 * @remarks
 * Manages service registration and resolution.
 * Implements singleton pattern for singleton services.
 */
export class Container {
  private services: Map<string, ServiceDescriptor> = new Map();

  /**
   * Registers a singleton service
   * 
   * @param name - Service name/identifier
   * @param factory - Factory function to create service instance
   */
  public registerSingleton<T>(name: string, factory: ServiceFactory<T>): void {
    this.services.set(name, {
      factory,
      lifecycle: 'singleton',
    });
  }

  /**
   * Registers a transient service
   * 
   * @param name - Service name/identifier
   * @param factory - Factory function to create service instance
   */
  public registerTransient<T>(name: string, factory: ServiceFactory<T>): void {
    this.services.set(name, {
      factory,
      lifecycle: 'transient',
    });
  }

  /**
   * Registers a value as a singleton
   * 
   * @param name - Service name/identifier
   * @param value - Pre-created service instance
   */
  public registerValue<T>(name: string, value: T): void {
    this.services.set(name, {
      factory: () => value,
      lifecycle: 'singleton',
      instance: value,
    });
  }

  /**
   * Resolves a service by name
   * 
   * @param name - Service name/identifier
   * @returns Resolved service instance
   * @throws {Error} If service is not registered
   */
  public resolve<T>(name: string): T {
    const descriptor = this.services.get(name);

    if (!descriptor) {
      const available = [];
      for (const key of this.services.keys()) {
        available.push(key);
      }
      throw new Error(
        `Service '${name}' not registered in container. ` +
        `Available services: ${available.join(', ')}`
      );
    }

    // Return cached singleton instance
    if (descriptor.lifecycle === 'singleton' && descriptor.instance) {
      return descriptor.instance as T;
    }

    // Create new instance
    const instance = descriptor.factory();

    // Cache singleton instance
    if (descriptor.lifecycle === 'singleton') {
      descriptor.instance = instance;
    }

    return instance as T;
  }

  /**
   * Checks if a service is registered
   * 
   * @param name - Service name/identifier
   * @returns True if service is registered
   */
  public has(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Removes a service registration
   * 
   * @param name - Service name/identifier
   */
  public unregister(name: string): void {
    this.services.delete(name);
  }

  /**
   * Clears all service registrations
   */
  public clear(): void {
    this.services.clear();
  }

  /**
   * Gets list of all registered service names
   * 
   * @returns Array of service names
   */
  public getServiceNames(): string[] {
    const names: string[] = [];
    for (const key of this.services.keys()) {
      names.push(key);
    }
    return names;
  }
}

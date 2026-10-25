/**
 * Metadata listing what a route requires ("permission:x", "feature:y", "module:z"). Appends (does not overwrite),
 * so several decorators can stack on one handler or class. Enforced by @mc/entitlements-sdk's EntitlementGuard and
 * listed by GET /internal/routes.
 */
export const REQUIRES = 'mc:requires';

export function appendRequires(...items: string[]): ClassDecorator & MethodDecorator {
  return (target: object, _key?: string | symbol, descriptor?: PropertyDescriptor) => {
    const holder = descriptor ? descriptor.value : target;
    const prev: string[] = Reflect.getMetadata(REQUIRES, holder) ?? [];
    Reflect.defineMetadata(REQUIRES, [...new Set([...prev, ...items])], holder);
    return descriptor as any;
  };
}

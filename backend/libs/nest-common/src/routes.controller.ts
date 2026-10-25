import { Controller, Get, Injectable, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { ACCESS, type Access, Internal } from './auth/auth.js';
import { REQUIRES } from './requires.js';

export interface RouteInfo {
  method: string;
  path: string;
  access: Access;
  requires: string[];
}

const join = (...parts: (string | undefined)[]) =>
  '/' + parts.flatMap((p) => (p ?? '').split('/')).filter(Boolean).join('/');

@Injectable()
export class RouteRegistry {
  constructor(private readonly discovery: DiscoveryService, private readonly scanner: MetadataScanner, private readonly reflector: Reflector) {}

  list(): RouteInfo[] {
    const out: RouteInfo[] = [];
    for (const w of this.discovery.getControllers()) {
      const proto = w.instance && Object.getPrototypeOf(w.instance);
      if (!proto || !w.metatype) continue;
      const base = Reflect.getMetadata(PATH_METADATA, w.metatype) as string | string[] | undefined;
      for (const name of this.scanner.getAllMethodNames(proto)) {
        const handler = proto[name];
        const path = Reflect.getMetadata(PATH_METADATA, handler);
        const method = Reflect.getMetadata(METHOD_METADATA, handler);
        if (path === undefined || method === undefined) continue;
        const access = this.reflector.getAllAndOverride<Access>(ACCESS, [handler, w.metatype]) ?? 'auth';
        const requires = this.reflector.getAllAndMerge<string[]>(REQUIRES, [handler, w.metatype]) ?? [];
        for (const b of [base].flat()) for (const p of [path].flat()) out.push({ method: RequestMethod[method], path: join(b, p), access, requires });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  }
}

/** Lets the platform leak test discover every route (and its access level) of every service. */
@Controller('internal/routes')
export class RoutesController {
  constructor(private readonly registry: RouteRegistry) {}

  @Get()
  @Internal()
  list() {
    return this.registry.list();
  }
}

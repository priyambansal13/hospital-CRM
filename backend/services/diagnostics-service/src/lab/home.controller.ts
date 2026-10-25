import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentActor, notFound, parse, TenantPublic } from '@mc/nest-common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import type { Actor } from '@mc/tenancy';
import { z } from 'zod';
import { HomeService } from './home.service.js';

const Uuid = z.uuid();
const id = (v: string, what: string) => { if (!Uuid.safeParse(v ?? '').success) throw notFound(what); return v; };
const Pincode = z.string().trim().regex(/^[1-9]\d{5}$/, '6-digit pincode');
const Area = z.object({ pincode: Pincode, branchId: z.uuid(), area: z.string().trim().max(100).nullable().default(null), fee: z.number().min(0).max(10_000).default(0), active: z.boolean().default(true) });
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const Windows = z.object({ windows: z.array(z.object({ day: z.number().int().min(1).max(7), start: Time, end: Time, slotMinutes: z.union([z.literal(15), z.literal(20), z.literal(30), z.literal(60)]).default(30), capacity: z.number().int().min(1).max(50).default(2) })).max(50) });
const Barcode = z.object({ barcode: z.string().trim().regex(/^S\d{8}$/i, 'barcode like S00001234') });

/** Before sign-in: "do you come to my pincode?" and the free home visit times. */
@Controller('v1/public/home-collection')
@RequireModule('home_collection')
export class PublicHomeController {
  constructor(private readonly home: HomeService) {}

  @Get('check')
  @TenantPublic()
  check(@Query('pincode') pincode: string) {
    return this.home.check(parse(Pincode, pincode));
  }

  @Get('slots')
  @TenantPublic()
  slots(@Query('pincode') pincode: string, @Query('date') date: string) {
    return this.home.slots(parse(Pincode, pincode), parse(z.iso.date(), date));
  }
}

/** Hospital admin: pincodes served, visit fee, home collection times per branch. */
@Controller('v1/admin')
@RequireModule('home_collection')
@RequirePermission('home_area:manage:tenant')
export class HomeAdminController {
  constructor(private readonly home: HomeService) {}

  @Get('home-areas')
  areas() { return this.home.areas(); }

  @Post('home-areas')
  @HttpCode(200)
  upsert(@Body() body: unknown) { return this.home.upsertArea(parse(Area, body)); }

  @Get('home-windows/:branchId')
  windows(@Param('branchId') b: string) { return this.home.homeWindows(id(b, 'branch')); }

  @Put('home-windows/:branchId')
  setWindows(@Param('branchId') b: string, @Body() body: unknown) { return this.home.setHomeWindows(id(b, 'branch'), parse(Windows, body).windows); }
}

/** Lab: the day's home collections and who goes where. */
@Controller('v1/lab/home-visits')
@RequireModule('home_collection')
export class HomeDispatchController {
  constructor(private readonly home: HomeService) {}

  @Get()
  @RequirePermission('home_visit:assign:branch')
  board(@Query('branchId') b: string, @Query('date') date: string | undefined, @CurrentActor() actor: Actor) {
    return this.home.board(actor, id(b, 'branch'), parse(z.iso.date().optional(), date));
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermission('home_visit:assign:branch')
  assign(@Param('id') v: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.home.assign(actor, id(v, 'home visit'), parse(z.object({ phlebotomistId: z.uuid() }), body).phlebotomistId);
  }
}

/** The phlebotomist's own visits. */
@Controller('v1/home-visits')
@RequireModule('home_collection')
@RequirePermission('home_visit:perform:own')
export class MyVisitsController {
  constructor(private readonly home: HomeService) {}

  @Get('mine')
  mine(@Query('date') date: string | undefined, @CurrentActor() actor: Actor) {
    return this.home.mine(actor, parse(z.iso.date().optional(), date));
  }

  @Post(':id/start')
  @HttpCode(200)
  start(@Param('id') v: string, @CurrentActor() actor: Actor) { return this.home.start(actor, id(v, 'home visit')); }

  @Post(':id/arrive')
  @HttpCode(200)
  arrive(@Param('id') v: string, @CurrentActor() actor: Actor) { return this.home.arrive(actor, id(v, 'home visit')); }

  @Post(':id/collect')
  @HttpCode(200)
  collect(@Param('id') v: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.home.collect(actor, id(v, 'home visit'), parse(Barcode, body).barcode);
  }

  @Post(':id/miss')
  @HttpCode(200)
  miss(@Param('id') v: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.home.miss(actor, id(v, 'home visit'), parse(z.object({ reason: z.string().trim().min(3).max(200) }), body).reason);
  }
}

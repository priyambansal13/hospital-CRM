import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentActor, Idempotent, notFound, parse, TenantPublic } from '@mc/nest-common';
import { RequireModule, RequirePermission } from '@mc/entitlements-sdk';
import { type Actor, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';
import { type Collection, LabService, toPackage, toTest } from './lab.service.js';

const Uuid = z.uuid();
const id = (v: string, what: string) => { if (!Uuid.safeParse(v ?? '').success) throw notFound(what); return v; };
const Items = z.array(z.object({ testId: z.uuid().optional(), packageId: z.uuid().optional() }).refine((i) => !!i.testId !== !!i.packageId, 'testId or packageId')).min(1).max(30);
const Pincode = z.string().trim().regex(/^[1-9]\d{5}$/, '6-digit pincode');
const HomeAddress = z.object({
  line1: z.string().trim().min(3).max(150), line2: z.string().trim().max(150).nullable().default(null), landmark: z.string().trim().max(100).nullable().default(null),
  city: z.string().trim().max(60).nullable().default(null), pincode: Pincode, phone: z.string().trim().regex(/^\+?\d{10,13}$/, 'phone number for the collector'),
});
/** At the lab: branchId. At home: the address (its pincode picks the branch). */
const Where = z.object({ branchId: z.uuid().optional(), home: HomeAddress.optional() }).refine((v) => !!v.branchId !== !!v.home, 'branchId or home address');
const where = (v: { branchId?: string; home?: z.infer<typeof HomeAddress> }): Collection => (v.home ? { type: 'HOME', address: v.home } : { type: 'AT_LAB', branchId: v.branchId! });
const Book = Where.and(z.object({ patientId: z.uuid(), slotAt: z.iso.datetime({ offset: true }), items: Items, paymentMode: z.enum(['ONLINE', 'AT_CLINIC']).default('AT_CLINIC') }));
const Schedule = Where.and(z.object({ slotAt: z.iso.datetime({ offset: true }), paymentMode: z.enum(['ONLINE', 'AT_CLINIC']).default('AT_CLINIC') }));
const DoctorOrder = z.object({ patientId: z.uuid(), encounterId: z.uuid().nullable().default(null), items: Items, note: z.string().trim().max(300).nullable().default(null) });
const Barcode = z.object({ barcode: z.string().trim().regex(/^S\d{8}$/i, 'barcode like S00001234') });
const Reject = Barcode.extend({ reason: z.string().trim().min(3).max(200) });
const TestPatch = z.object({ price: z.number().min(0).max(1_000_000).optional(), active: z.boolean().optional(), preparation: z.string().trim().max(300).nullable().optional() });
const PackagePatch = z.object({ price: z.number().min(0).max(1_000_000).optional(), active: z.boolean().optional() });

/** Catalog and collection times, before sign-in. */
@Controller('v1/public')
@RequireModule('diagnostics')
export class PublicLabController {
  constructor(private readonly lab: LabService, private readonly db: TenantDbRouter) {}

  @Get('lab-catalog')
  @TenantPublic()
  catalog(@Query('q') q: string | undefined) {
    return this.lab.catalog(q);
  }

  @Get('lab-branches')
  @TenantPublic()
  async branches() {
    const { rows } = await this.db.query(`SELECT b.id, b.name FROM branches b WHERE b.active AND EXISTS (SELECT 1 FROM collection_windows w WHERE w.branch_id = b.id AND w.kind = 'LAB') ORDER BY b.name`);
    return rows;
  }

  @Get('lab-slots')
  @TenantPublic()
  slots(@Query('branchId') branchId: string, @Query('date') date: string) {
    return this.lab.slots(id(branchId, 'branch'), parse(z.iso.date(), date));
  }
}

@Controller('v1')
@RequireModule('diagnostics')
export class LabOrdersController {
  constructor(private readonly lab: LabService) {}

  @Post('lab-orders')
  @Idempotent()
  @RequirePermission('lab_order:create:own')
  book(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const v = parse(Book, body);
    return this.lab.bookByPatient(actor, { ...v, collection: where(v) });
  }

  @Get('me/lab-orders')
  @RequirePermission('lab_order:read:own')
  mine(@CurrentActor() actor: Actor) {
    return this.lab.myOrders(actor);
  }

  @Post('lab-orders/:id/schedule')
  @HttpCode(200)
  @RequirePermission('lab_order:create:own')
  schedule(@Param('id') o: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const v = parse(Schedule, body);
    return this.lab.scheduleByPatient(actor, id(o, 'lab order'), { ...v, collection: where(v) });
  }

  @Post('lab-orders/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id') o: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.lab.cancel(actor, id(o, 'lab order'), parse(z.object({ reason: z.string().trim().max(200).nullable().default(null) }), body ?? {}).reason);
  }

  @Get('lab-orders/:id')
  get(@Param('id') o: string, @CurrentActor() actor: Actor) {
    return this.lab.get(actor, id(o, 'lab order'));
  }

  /** A treating doctor orders tests (usually from the consultation screen). */
  @Post('doctor/lab-orders')
  @Idempotent()
  @RequirePermission('lab_order:create:treating')
  order(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.lab.orderByDoctor(actor, parse(DoctorOrder, body));
  }
}

/** The lab bench: worklist and barcode scans. */
@Controller('v1/lab')
@RequireModule('diagnostics')
export class LabBenchController {
  constructor(private readonly lab: LabService) {}

  @Get('worklist')
  @RequirePermission('lab_order:read:branch')
  worklist(@Query('branchId') b: string, @Query('date') date: string | undefined, @CurrentActor() actor: Actor) {
    return this.lab.worklist(actor, id(b, 'branch'), parse(z.iso.date().optional(), date));
  }

  @Post('samples/collect')
  @HttpCode(200)
  @RequirePermission('sample:collect:branch')
  collect(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.lab.collect(actor, parse(Barcode, body).barcode);
  }

  @Post('samples/receive')
  @HttpCode(200)
  @RequirePermission('sample:collect:branch')
  receive(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.lab.receive(actor, parse(Barcode, body).barcode);
  }

  /** X-ray, ECG and other tests without a sample: the patient was seen, the report can be written. */
  @Post('lab-orders/:id/performed')
  @HttpCode(200)
  @Idempotent()
  @RequirePermission('sample:collect:branch')
  performed(@Param('id') orderId: string, @CurrentActor() actor: Actor) {
    return this.lab.performed(actor, id(orderId, 'lab order'));
  }

  @Post('samples/reject')
  @HttpCode(200)
  @RequirePermission('sample:collect:branch')
  reject(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const v = parse(Reject, body);
    return this.lab.reject(actor, v.barcode, v.reason);
  }
}

/** Hospital admin: prices, preparation, switching tests/packages on and off. */
@Controller('v1/admin')
@RequireModule('diagnostics')
@RequirePermission('lab_catalog:manage:tenant')
export class LabCatalogAdminController {
  constructor(private readonly db: TenantDbRouter) {}

  @Get('lab-catalog')
  async all() {
    const { rows: tests } = await this.db.query('SELECT * FROM lab_tests ORDER BY category, name');
    const { rows: pkgs } = await this.db.query(`SELECT p.*, coalesce(json_agg(json_build_object('code', t.code, 'name', t.name, 'price', t.price) ORDER BY t.name) FILTER (WHERE t.id IS NOT NULL), '[]') AS tests
      FROM lab_packages p LEFT JOIN package_tests pt ON pt.package_id = p.id LEFT JOIN lab_tests t ON t.id = pt.test_id GROUP BY p.id ORDER BY p.name`);
    return { tests: tests.map(toTest), packages: pkgs.map(toPackage) };
  }

  @Patch('lab-tests/:id')
  async patchTest(@Param('id') t: string, @Body() body: unknown) {
    const v = parse(TestPatch, body);
    const { rows } = await this.db.query(
      `UPDATE lab_tests SET price = coalesce($2, price), active = coalesce($3, active), preparation = CASE WHEN $4::boolean THEN $5 ELSE preparation END, updated_at = now() WHERE id = $1 RETURNING *`,
      [id(t, 'test'), v.price ?? null, v.active ?? null, v.preparation !== undefined, v.preparation ?? null]);
    if (!rows[0]) throw notFound('test');
    return toTest(rows[0]);
  }

  @Patch('lab-packages/:id')
  async patchPackage(@Param('id') p: string, @Body() body: unknown) {
    const v = parse(PackagePatch, body);
    const { rows } = await this.db.query(`UPDATE lab_packages SET price = coalesce($2, price), active = coalesce($3, active), updated_at = now() WHERE id = $1 RETURNING *`, [id(p, 'package'), v.price ?? null, v.active ?? null]);
    if (!rows[0]) throw notFound('package');
    return toPackage(rows[0]);
  }
}

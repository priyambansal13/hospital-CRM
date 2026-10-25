import { Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { AvailabilityChanged, AppointmentChanged, DoctorChanged, EventTypes, Topics } from '@mc/contracts';
import { ConsumerRegistry, CoreModule } from '@mc/nest-common';
import { EntitlementsModule } from '@mc/entitlements-sdk';
import { TenantContext } from '@mc/tenancy';
import { IndexerService } from './indexer.service.js';
import { OpenSearch } from './opensearch.js';
import { InternalSearchController, SearchController } from './search.controller.js';

/**
 * Events keep the indexes current. A failed update is logged, not retried into the DLQ: the periodic sync repairs it,
 * and a search engine outage must not back up the event stream.
 */
@Injectable()
class SearchConsumers implements OnModuleInit {
  private readonly log = new Logger('SearchConsumers');
  constructor(private readonly registry: ConsumerRegistry, private readonly indexer: IndexerService) {}

  private safe(what: string, fn: () => Promise<unknown>) {
    return fn().then(() => undefined, (e) => this.log.warn(`${what}: ${(e as Error).message}`));
  }

  onModuleInit() {
    this.registry.register({
      group: 'search.tenants',
      topics: [Topics.tenant],
      handlers: { [EventTypes.tenantProvisioned]: () => this.safe('ensure indexes', () => this.indexer.ensure(TenantContext.require())) },
    });
    const doctor = (e: { data: unknown }) => this.safe('doctor', () => this.indexer.upsertDoctor(TenantContext.require(), DoctorChanged.parse(e.data).doctorId));
    this.registry.register({
      group: 'search.doctors',
      topics: [Topics.provider],
      handlers: { [EventTypes.doctorCreated]: doctor, [EventTypes.doctorUpdated]: doctor },
    });
    const next = (doctorId: string) => this.safe('next available', () => this.indexer.refreshNext(TenantContext.require(), doctorId));
    const appt = (e: { data: unknown }) => next(AppointmentChanged.parse(e.data).doctorId);
    this.registry.register({
      group: 'search.availability',
      topics: [Topics.scheduling],
      handlers: {
        [EventTypes.availabilityChanged]: (e) => next(AvailabilityChanged.parse(e.data).doctorId),
        ...Object.fromEntries([EventTypes.appointmentBooked, EventTypes.appointmentCancelled, EventTypes.appointmentRescheduled, EventTypes.appointmentExpired, EventTypes.appointmentPendingPayment].map((t) => [t, appt])),
      },
    });
  }
}

@Module({
  imports: [CoreModule.forRoot({ schema: 'search', control: false, tenant: true, relay: false }), EntitlementsModule],
  controllers: [SearchController, InternalSearchController],
  providers: [{ provide: OpenSearch, useFactory: () => new OpenSearch() }, IndexerService, SearchConsumers],
})
export class AppModule {}

import { bootstrapService } from '@mc/nest-common';
import { AppModule } from './app.module.js';

await bootstrapService(AppModule, { name: 'billing-service', port: 4409, rawBody: true });

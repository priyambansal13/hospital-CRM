import { bootstrapService } from '@mc/nest-common';
import { AppModule } from './app.module.js';

await bootstrapService(AppModule, { name: 'records-service', port: 4410 });

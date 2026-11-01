import { bootstrapService } from '@mc/nest-common';
import { AppModule } from './app.module.js';

await bootstrapService(AppModule, { name: 'analytics-service', port: 4417 });

import { bootstrapService } from '@mc/nest-common';
import { AppModule } from './app.module.js';

await bootstrapService(AppModule, { name: 'search-service', port: 4414 });

import { bootstrapService } from '@mc/nest-common';
import { AppModule } from './app.module.js';

await bootstrapService(AppModule, { name: 'diagnostics-service', port: 4412 });

import { bootstrapService } from '@mc/nest-common';
import { AppModule } from './app.module.js';

// rawBody: the WhatsApp webhook's signature is over the exact bytes Meta sent
await bootstrapService(AppModule, { name: 'ai-assistant-service', port: 4415, rawBody: true });

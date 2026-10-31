import { bootstrapService } from '@mc/nest-common';
import { AppModule } from './app.module.js';

// 16 MB: consultation recordings for the AI scribe arrive as base64 (up to SCRIBE_AUDIO_MAX_BYTES, 10 MB)
await bootstrapService(AppModule, { name: 'records-service', port: 4410, bodyLimitBytes: 16 * 1024 * 1024 });

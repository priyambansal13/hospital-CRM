import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Internal } from '../auth/auth.js';
import { notFound } from '../errors.js';
import { FieldCrypto } from './field-crypto.js';

/**
 * Key operations for a service that encrypts (records, assistant), driven by `mc keys …`: a new data key version for
 * a hospital, and re-wrapping every data key with the current master key (KEK rotation, or moving to Cloud KMS).
 */
@Controller('internal')
export class InternalKeysController {
  constructor(private readonly crypto: FieldCrypto) {}

  @Post('tenants/:tenantId/keys/rotate')
  @Internal()
  @HttpCode(200)
  rotate(@Param('tenantId') tenantId: string) {
    if (!z.uuid().safeParse(tenantId).success) throw notFound('tenant');
    return this.crypto.rotate(tenantId);
  }

  @Post('keys/rewrap')
  @Internal()
  @HttpCode(200)
  rewrap() {
    return this.crypto.rewrapAll();
  }
}

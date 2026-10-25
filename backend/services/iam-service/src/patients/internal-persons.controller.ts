import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { PhoneNumber } from '@mc/contracts';
import { CONTROL_DB, Internal, parse } from '@mc/nest-common';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';

const EnsurePerson = z.object({ phone: PhoneNumber });

/**
 * Service-to-service: the global person for a phone number, created if new. patient-service uses it when the front
 * desk registers a walk-in: the record belongs to that phone, so when the patient later signs in with an OTP they
 * see it (and their appointments) straight away.
 */
@Controller('internal/persons')
export class InternalPersonsController {
  constructor(@Inject(CONTROL_DB) private readonly control: pg.Pool) {}

  @Post()
  @Internal()
  @HttpCode(200)
  async ensure(@Body() body: unknown) {
    const { phone } = parse(EnsurePerson, body);
    const { rows } = await this.control.query(
      `INSERT INTO persons (id, phone) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING id, (xmax = 0) AS created`,
      [randomUUID(), phone],
    );
    return { personId: rows[0].id as string, phone, created: rows[0].created as boolean };
  }
}

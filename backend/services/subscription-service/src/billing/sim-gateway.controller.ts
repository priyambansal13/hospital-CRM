import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CONTROL_DB, DomainError, isDev, notFound, parse, Public } from '@mc/nest-common';
import type pg from 'pg';
import { z } from 'zod';
import { simulateAuthorise } from './gateway.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const Card = z.object({ number: z.string().trim().min(12).max(23), expiry: z.string().trim().max(5), name: z.string().trim().min(2).max(80) });

/**
 * Local development only: a stand-in for the payment gateway's hosted card page (Razorpay Checkout's mandate page in
 * production). It belongs to the "gateway", not to MediCare's apps: the card is typed here, only brand, last 4 digits
 * and a mandate id are kept, and the customer is sent back to the hospital's site.
 */
@Controller('v1/sim-gateway')
export class SimGatewayController {
  constructor(@Inject(CONTROL_DB) private readonly db: pg.Pool) {}

  private async session(id: string) {
    if (!isDev()) throw notFound('page');
    if (!z.uuid().safeParse(id).success) throw notFound('session');
    const { rows: [s] } = await this.db.query(`SELECT * FROM card_sessions WHERE id = $1 AND status = 'PENDING' AND expires_at > now()`, [id]);
    if (!s) throw notFound('session');
    return s;
  }

  @Get('mandate/:id')
  @Public()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async page(@Param('id') id: string, @Query('return') ret: string) {
    await this.session(id);
    const back = z.url().safeParse(ret).success ? ret : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulated payment gateway</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#1d2433}label{display:block;margin:12px 0 4px}input{width:100%;padding:8px;font-size:16px;box-sizing:border-box}button{margin-top:16px;padding:10px 16px;font-size:16px;background:#2f5bd3;color:#fff;border:0;border-radius:6px;cursor:pointer}.note{color:#667;font-size:13px}.err{color:#b42318}</style></head>
<body><h1>Simulated gateway</h1><p class="note">Test mode: the card stays with the gateway; the hospital's app only learns the brand and last 4 digits.<br>4111 1111 1111 1111 pays; 4000 0000 0000 0002 is declined at renewal.</p>
<form id="f" aria-label="Card"><label for="number">Card number</label><input id="number" name="number" inputmode="numeric" autocomplete="cc-number" required>
<label for="expiry">Expiry (MM/YY)</label><input id="expiry" name="expiry" placeholder="12/30" required>
<label for="name">Name on card</label><input id="name" name="name" autocomplete="cc-name" required>
<button>Authorise card</button><p id="e" class="err" role="alert"></p></form>
<script>document.getElementById('f').addEventListener('submit',async(ev)=>{ev.preventDefault();const f=new FormData(ev.target);
const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(f))});
const j=await r.json();if(!r.ok){document.getElementById('e').textContent=j.detail||'refused';return}location.href=${JSON.stringify(esc(back))}.replace(/&amp;/g,'&');});</script></body></html>`;
  }

  @Post('mandate/:id')
  @Public()
  @HttpCode(200)
  async authorise(@Param('id') id: string, @Body() body: unknown) {
    await this.session(id);
    const card = parse(Card, body);
    let mandate;
    try {
      mandate = simulateAuthorise(card);
    } catch (e) {
      throw new DomainError(422, 'CARD_REFUSED', (e as Error).message);
    }
    await this.db.query(`INSERT INTO sim_mandates (session_id, mandate) VALUES ($1,$2) ON CONFLICT (session_id) DO UPDATE SET mandate = $2, error = NULL`, [id, JSON.stringify(mandate)]);
    return { ok: true, brand: mandate.brand, last4: mandate.last4 };
  }
}

# Payment provider outage

**Signs:**
- Online bookings fail with 502 `PAYMENTS_UNAVAILABLE`;
- support tickets ("payment page doesn't open");
- Razorpay's status page.

## What still works (tested by `mc test chaos`)

- **Pay at the hospital** works, and the front desk takes cash, UPI and card as usual.
- An online booking that can't open a payment **gives its slot back at once**, so nobody holds a time they can't pay for.
- When the provider is back, online booking works again without any action.
- Payments made just before the outage are settled when the provider's webhooks arrive. Webhooks are retried by the provider, and duplicates are ignored. A late payment for an expired hold is refunded automatically.

## Do

1. **Post on the status page:** component payments, impact Major: "Online payment is failing. Choose pay at the hospital; your booking is kept."
2. **Check Razorpay** (status page, dashboard): API errors, or webhooks not delivered.
3. **Our side:**
   - billing-service logs for gateway errors;
   - the Razorpay keys in Secret Manager (expired or rotated?);
   - the Cloud NAT addresses, if Razorpay allow-lists them (Terraform output `nat_addresses`).
4. **Refunds asked for during the outage** wait in billing and are retried. Check the billing desk for refunds still pending afterwards.

## Confirm

- A test online booking on a test hospital reaches the payment page.
- Resolve the incident.

**Locally:** `POST /internal/simulator/outage {"seconds": 300}` on billing-service simulates the outage (dev only).

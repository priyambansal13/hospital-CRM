# medicare-frontend

Next.js Multi-Zones (docs: `../platform/docs/MICROFRONTENDS.md`). The shell (port 3400) owns `/`, sign-in and
`/auth/*`, and rewrites each zone's base path (from `zones.json`) to that zone. Every zone serves every hospital;
the hospital comes from the host name.

| Path | What |
|---|---|
| `apps/zone-shell` | Landing, staff sign-in (Keycloak, PKCE), patient OTP sign-in, session refresh, logout |
| `apps/zone-patient` | `/care`: find a doctor (public), book a slot, my appointments (cancel/reschedule), my family, waitlist |
| `apps/zone-doctor` | `/doctor`: my schedule (hours, leave, upcoming slots), appointments |
| `apps/zone-admin` | `/admin`: overview, branches, staff, doctors, specialties, schedules, messages |
| `packages/ui` | Design system (`theme.css` tokens, AppFrame, forms, tables) |
| `packages/auth` | Encrypted session cookies, OIDC, patient OTP, `requireSession` / `actionSession` |
| `packages/bff` | Gateway calls with `X-Tenant-Host`, RFC 7807 errors, branding |
| `packages/schedule-ui` | Schedule editor shared by the doctor and admin zones (actions passed in) |
| `packages/features` | Capabilities, `<Can>` / `<Feature>`, `ZoneFrame` (nav from capabilities) |

New zone: `pnpm gen zone <name> --base /path`, then add nav items for it in a backend module manifest.

Images: `docker build --build-arg ZONE=<name> .` (one Dockerfile for all zones). The shell's rewrites are fixed at build time from `ZONE_URL_TEMPLATE` (default `http://zone-{name}:3000`).

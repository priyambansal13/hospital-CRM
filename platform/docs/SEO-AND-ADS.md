# MediCare: SEO and ads

How MediCare gets found and wins customers through search and paid ads. This goes with [SALES-STORY.md](SALES-STORY.md), which says what to say once a prospect arrives.

There are **two audiences** and they need different plans:

| | Who searches | What they search | Goal |
|---|---|---|---|
| **A. MediCare itself** (B2B) | Hospital owners, clinic doctors, lab owners, operations managers | "clinic management software", "hospital software India", "lab report software" | A trial signup or a demo request |
| **B. Each hospital's own site** (a product feature we sell) | Patients | "cardiologist in Gurugram", "CBC test near me", "Dr. Ananya Sharma" | A booking on the hospital's site |

Plan B is also a selling point: **"your doctors and tests show up on Google, and the click books on your own site, not a marketplace's"**. Today it isn't built (see §2.1).

Budgets, volumes and rates below are **planning assumptions to check**, not measured data.

---

## 1. SEO for MediCare (B2B)

### 1.1 Keywords

Group the keywords by intent and give each group one page to rank for it.

| Group | Example searches | Intent | Page |
|---|---|---|---|
| Category | clinic management software, hospital management software India, HMS software, practice management software | Comparing products | `/` and `/features` |
| Segment | software for diagnostic centre, pathology lab software, dental clinic software, eye hospital software, multi-branch clinic software | Fit for their type | `/for/clinics`, `/for/diagnostic-centres`, `/for/hospitals`, `/for/dental`, `/for/eye-care` |
| Job to be done | online appointment booking for clinic, OPD queue token system, lab report online with QR, home sample collection app, e-prescription software | A specific problem | `/features/<feature>` (booking, front desk, EMR, lab, home collection, AI assistant, analytics) |
| Compliance and trust | DPDP compliant hospital software, ABDM integrated software, patient data security India | Risk and IT checks | `/security`, `/compliance` |
| Price | clinic software price, HMS cost per month | Ready to buy | `/pricing` (live plans) |
| Comparison | `<competitor>` alternative, `<competitor>` vs | Switching | `/compare/<competitor>` (factual, dated, no disparaging claims) |
| Local | hospital software Delhi NCR, clinic software Bangalore | Local sales | City pages only once there are customers or a sales person there |
| Hindi / Hinglish | clinic software hindi, hospital ka software | Smaller clinics | Hindi versions of the segment pages, later |

Check volumes and difficulty in Google Keyword Planner and Search Console before writing. Start with **segment** and **job-to-be-done** pages: competition is lower and the intent is closer to buying.

### 1.2 Site pages to build (marketing site, zone-shell)

| Page | Content | Call to action |
|---|---|---|
| `/` | The one-line pitch, the problem, the Monday story (short), proof points, plans | Start free trial · Book a demo |
| `/features` and `/features/<feature>` | One page per module: the problem, screenshots from Aarogya, how it works, which plans include it | Trial |
| `/for/<segment>` | One page per buyer type from SALES-STORY §3, using that buyer's own words | Demo |
| `/pricing` | Already live from the published plans; add an FAQ and the ROI worked example | Trial |
| `/security`, `/compliance` | Database per hospital, encryption, access log, backups with restore drills, DPDP rights, data residency | Demo |
| `/compare/<competitor>` | A factual table, dated, with sources | Demo |
| `/resources/<article>` | Guides that answer what owners search (below) | Newsletter, trial |
| `/demo` | A short form (name, hospital, city, doctors, phone) that creates a sales lead | — |

**Content calendar (first 3 months, about 2 articles a week).** Examples:
- "How to cut OPD no-shows: reminders, waitlists and outreach"
- "DPDP Act for clinics: what you must do with patient data"
- "Online booking for your clinic without a marketplace commission"
- "Lab report turnaround time: how to measure it and bring it down"
- "Paper register to software: a 30-day plan for a 10-doctor clinic"
- "ABDM for private clinics: what it means and how to start"

Each article links to the matching feature page. A doctor or hospital operations person should review clinical and legal articles before they go live.

### 1.3 Technical SEO for the marketing site

- A unique `title` and `description` on every page, plus Open Graph and Twitter cards for sharing on WhatsApp and LinkedIn.
- `sitemap.xml` and `robots.txt`.
- Structured data:
  - `Organization` and `SoftwareApplication` (with `offers` from the live plans);
  - `FAQPage` on pricing;
  - `Article` on resources;
  - `BreadcrumbList`.
- Speed: the marketing pages render on the server and need no sign-in, so keep them static or cached. Aim for good Core Web Vitals on mobile (most Indian owners browse on phones).
- One preferred address per page (canonical). Keep the console, `/account`, `/signup/status` and every staff zone out of the index (`noindex` and `robots`).
- Google Search Console and Bing Webmaster Tools, with the sitemap submitted.

### 1.4 Off-site

- **Listings:** Google Business Profile for MediCare's office, plus profiles on Capterra, G2, GetApp and SoftwareSuggest (Indian buyers use these to compare software).
- **Reviews:** ask each pilot hospital for a review once its three pilot numbers are measured.
- **Partners and links:** state IMA chapters, diagnostic and lab associations, medical-equipment distributors, and CA firms that serve clinics.
- **PR:** each real pilot result is a story ("Gurugram hospital cuts no-shows by X%"), but only with the hospital's written consent and real numbers.

---

## 2. SEO for each hospital's site (product feature)

When a patient searches "cardiologist in Noida" or "Dr. Rohan Mehta", the hospital's own page on MediCare should rank and take the booking. This is a strong selling point against marketplaces.

### 2.1 What exists today

| Item | State |
|---|---|
| Page titles | Fixed per zone ("Patient · MediCare"). Not the hospital's name or the doctor's. |
| Meta description, Open Graph | None |
| `sitemap.xml`, `robots.txt` | None |
| Structured data (schema.org) | None |
| Public pages render on the server | ✅ Hospital home, doctor directory, doctor profiles, tests and packages (good for crawling) |
| Readable addresses | ⚠️ Doctor and test pages use IDs (`/care/doctors/<uuid>`), not names |
| Custom domain per hospital | ✅ (`core.custom_domain`, Enterprise) |
| Staff zones kept out of search | ⚠️ Not marked `noindex` (they need sign-in, so little is exposed, but they should still be marked) |

### 2.2 What to build (proposed as a small phase)

1. **Metadata per page, from data:**
   - hospital home: "Aarogya Hospitals, Gurugram · Book doctors and lab tests online";
   - doctor: "Dr. Ananya Sharma, Cardiologist, Aarogya Hospitals Gurugram · Book appointment";
   - specialty: "Cardiologists at Aarogya Hospitals";
   - test: "HbA1c test price ₹… · Aarogya Hospitals".
   - Each with a description and Open Graph tags carrying the hospital's logo and colours.
2. **Readable addresses:**
   - `/care/doctors/ananya-sharma-cardiology`, `/care/specialties/cardiology`, `/care/tests/hba1c`;
   - the old ID links redirect permanently (301).
3. **Sitemap and robots per hospital host:**
   - `sitemap.xml` lists only published doctors, active specialties, branches, tests and packages;
   - `robots.txt` blocks `/care/*` patient pages that need sign-in, every staff zone and the API;
   - sitemaps are rebuilt when a doctor or test is published, unpublished or renamed.
4. **Structured data:**
   - `Hospital` or `MedicalClinic` or `DiagnosticLab` per branch, with address, phone, opening hours and geo;
   - `Physician` per doctor, with `medicalSpecialty`, `worksFor`, languages and an appointment link;
   - `MedicalTest` and `Offer` for tests and packages, with prices;
   - `BreadcrumbList`.
5. **Branch pages:** `/care/branches/noida-sector-62` with address, timings, map, doctors and tests there. These are the pages that win "near me" searches.
6. **Google Business Profile help:** an admin checklist that links each branch's profile to its MediCare booking page, with UTM tags so `/admin/analytics` can count bookings from Google.
7. **Admin SEO settings** (`/admin/settings` → Search): hospital description, the city or area for each branch, and per-doctor bio checks such as "too short" or "no photo".
8. **Plan gating:**
   - every plan with `patient_app` gets the basics (metadata, sitemap, structured data);
   - Enterprise adds a custom domain and branch landing pages;
   - offering a reviewed SEO content pack could be an add-on.
9. **Rules that must hold:**
   - no patient data in any public page, sitemap or structured data;
   - unpublished doctors leave the sitemap and their pages return 410 (gone);
   - the tenancy leak test is extended to sitemaps;
   - a suspended hospital's pages are `noindex`.

**Tests:**
- every public page has a unique title and a canonical link;
- the sitemap contains only public, active items;
- structured data passes validation (schema.org JSON is checked in CI);
- one hospital's sitemap never lists another hospital's doctors.

---

## 3. Paid ads (B2B, to win hospitals)

### 3.1 Channels

| Channel | Use it for | Targeting | Lands on |
|---|---|---|---|
| **Google Search** | People already looking for software (highest intent) | Keyword groups from §1.1, India, English; Hindi later | Matching segment or feature page |
| **Google Performance Max / Display remarketing** | Visitors who left without signing up | Site visitors in the last 30 days | `/pricing`, `/demo` |
| **Meta (Facebook, Instagram)** | Clinic doctors and small-lab owners, who are on Instagram and Facebook more than LinkedIn | Interests (medicine, clinic, pathology), job titles, lookalikes of trial signups; city targeting | `/for/clinics`, `/for/diagnostic-centres`; Lead Ads into the demo list |
| **LinkedIn** | Hospital and chain decision makers | Job titles (CEO, COO, Medical Director, Hospital Administrator), industry Hospitals & Health Care, company size 50–1,000 | `/for/hospitals`, `/security` |
| **YouTube** | The 60-second "Monday morning" story | Remarketing plus healthcare-business audiences | `/` |
| **WhatsApp click-to-chat** (from Meta ads) | Indian owners who prefer to talk | Same as Meta | Sales WhatsApp number |

### 3.2 Campaign structure (Google Search)

```
Campaign: Segment – Clinics            → /for/clinics
  Ad group: clinic management software
  Ad group: clinic appointment software
  Ad group: OPD token system
Campaign: Segment – Diagnostic centres → /for/diagnostic-centres
  Ad group: pathology lab software
  Ad group: lab report online / QR
  Ad group: home sample collection app
Campaign: Segment – Hospitals          → /for/hospitals
  Ad group: hospital management software
  Ad group: multi-branch hospital software
Campaign: Brand                        → /
  Ad group: medicare crm / medicare hospital software
Campaign: Competitors (later, small)   → /compare/<competitor>
```

**Negative keywords**:
- job-seekers: "free download", "crack", "course", "jobs", "salary", "project report", "pdf";
- patients searching for MediCare-named schemes or insurance: "Medicare", "Mediclaim", "government hospital".

**"Medicare" is also the US government health-insurance programme.** It brings a lot of searches that have nothing to do with us. Target India only, and add "US Medicare" terms as negatives. This name clash also argues for checking the product name before spending heavily on brand (see §5).

### 3.3 Ad copy (examples)

**Google Search, Clinics**
- Headlines:
  - "Clinic Software from ₹4,999/mo"
  - "Online Booking on Your Own Site"
  - "Queue Tokens · E-Prescriptions"
  - "Live in a Day · Free Trial"
- Descriptions:
  - "Booking, front desk, prescriptions and billing in one app, under your clinic's name. Start free."
  - "Reminders cut no-shows. Patients see who opened their records. Built for India."

**Google Search, Diagnostic centres**
- Headlines:
  - "Lab Software with QR Reports"
  - "Home Sample Collection App"
  - "Critical Values Never Missed"
- Description: "Barcode labels, results checked against ranges, reports on the patient's phone with QR proof. Free trial."

**Meta (image or short video)**
- Hook: "Still running your clinic on a register and WhatsApp?"
- Body: "Patients book on your own website, the desk gives tokens nobody can argue with, prescriptions reach the patient's phone. From ₹4,999 a month."
- Call to action: "Start free trial" or "Send a WhatsApp".

**LinkedIn (hospitals)**
- "Every branch on one screen. Every record access logged. Every backup test-restored. See MediCare in 20 minutes." → Book a demo.

Rules for all ad copy:
- **No medical claims, no cure or outcome promises**, and no patient photos or data.
- Numbers ("cut no-shows by X%") only after a real pilot measures them, with consent to use them.

### 3.4 Budget and targets (assumptions for the first 90 days)

| Item | Assumption |
|---|---|
| Monthly budget | ₹1.5–2 lakh: Google Search 55%, Meta 25%, LinkedIn 15%, remarketing 5% |
| Cost per click (India, B2B software) | Roughly ₹40–150 on Google; check in Keyword Planner |
| Visit → trial or demo | 3–5% on a good segment landing page |
| Trial → paying | 15–25% for self-serve clinics; demos convert higher for hospitals |
| Target cost per paying customer | Below 3 months of the plan's revenue (e.g. under ₹15,000 for Clinic Starter, under ₹75,000 for Hospital Pro) |

Run Search first (weeks 1–4). Add Meta and remarketing once the landing pages convert (weeks 5–8). Add LinkedIn with the first real case study (weeks 9–12). Stop any ad group that has spent 3× the target cost per customer without a trial.

### 3.5 Measuring it (and staying out of patient data)

- **The funnel:** ad click → landing page → `/signup` or `/demo` → signup confirmed → hospital READY → first booking → paid subscription.
- **What to build:**
  - UTM parameters saved with the signup (`tenant.signups`: source, medium, campaign, term);
  - a `lead` record for `/demo`;
  - conversions sent to Google Ads and Meta from the server (Enhanced Conversions, the Conversions API) using **only the signup e-mail, hashed**.
- **Hard rule: tracking pixels go only on the marketing site** (`localhost:3400` in dev; medicare.in or similar in production).
  - **Never** on a hospital's patient site, `/care`, the patient app or any staff zone.
  - Pixels on health pages would send patients' health information to ad platforms. That breaks the DPDP Act's purpose limits and the ad platforms' own health-data policies, and it would destroy the trust story in SALES-STORY §7.
- **Consent:** a cookie and consent banner on the marketing site; no ad cookies before consent.
- **Report weekly:** spend, clicks, trials, demos, paying customers and cost per customer, by campaign, in a sheet or in the HQ analytics.

---

## 4. Ads that hospitals run (optional feature, later)

Hospitals on MediCare will want to advertise to patients too ("cardiac check-up package ₹1,999"). Help them without risking patient data:
- **Shareable package and doctor links with UTM tags** from `/admin`. Bookings from them show by source in `/admin/analytics`.
- **Landing pages** for a package or a health camp, built from the catalogue.
- **No ad pixels on patient pages, and no customer-list uploads.** Retargeting by health condition is exactly what the law and the ad platforms forbid.
- A **checklist in the admin** for India's rules on medical advertising:
  - the Drugs and Magic Remedies (Objectionable Advertisements) Act;
  - the NMC professional-conduct rules on what individual doctors may advertise;
  - Google's and Meta's healthcare ad policies.
  - The hospital is responsible for its own ads; MediCare provides the links and the measurement.

---

## 5. Before spending

1. **The name.** "MediCare" clashes with the US Medicare programme and with existing Indian healthcare brands. Run a trademark check (India class 9, 42 and 44) and look at what the search results show before buying brand ads or a domain. A distinct name would make SEO and ads much cheaper.
2. **The domain**, Google Search Console, Google Ads and Meta Business accounts, plus a consent banner.
3. **Landing pages** (§1.2) and the funnel tracking (§3.5) built and tested.
4. **A real demo environment** in the cloud, not localhost, so the "Book a demo" and trial links work. This needs the GCP project.
5. **Proof:** at least one pilot hospital, so ads can quote real numbers.

## 6. Build items this adds to the plan

| Item | Where | Size |
|---|---|---|
| Hospital-site SEO: metadata, readable addresses, sitemap and robots per host, structured data, branch pages, `noindex` on staff zones, tests | zone-shell, zone-patient, provider and diagnostics (slugs), search | about 1–2 weeks |
| Marketing site pages: features, segments, security, compare, resources, demo form with lead capture | zone-shell, tenant-service (`leads`) | about 1–2 weeks plus content writing |
| Funnel tracking: UTM on signups and leads, server-side conversions (hashed e-mail), consent banner, pixels only on the marketing host | zone-shell, tenant-service | about 1 week |
| Hospital campaign links and source analytics | admin, analytics | a few days |

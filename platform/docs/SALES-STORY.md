# MediCare: the sales story

How to sell MediCare: who buys it, the story to tell, what to show in a demo, how to price it, and how to answer the usual objections.

Everything claimed here is built and tested (see [APP-FLOWS-AND-LOGINS.md](APP-FLOWS-AND-LOGINS.md)). The people, hospitals and numbers in the stories are **illustrative**: there are no customers yet. Replace them with real pilot results as soon as there are some. Items that still need a provider account are listed in §9; don't promise them as live.

---

## 1. One line

**MediCare runs a hospital, clinic or diagnostic lab end to end (online booking, front desk, doctor's consultation, lab reports, billing and an AI assistant) under the hospital's own name, with every patient's record locked to the people treating them.**

Shorter, for a slide: **Your hospital, online in a day. Your patients, looked after end to end.**

---

## 2. The problem we solve

Most Indian clinics, mid-size hospitals and diagnostic labs run on a mix of a phone, a register at the desk, WhatsApp, a billing program, a separate lab system and paper prescriptions.

| Who feels it | What it looks like today |
|---|---|
| **Patients** | Call several times to get an appointment; wait without knowing how long; collect lab reports in person; lose old prescriptions; no idea who has seen their records. |
| **Front desk** | A paper register, a queue argument every morning, cash that doesn't add up at night, refunds tracked on scraps. |
| **Doctors** | Handwritten notes, no history in front of them, a prescription that misses an allergy, critical lab values that reach them late. |
| **Lab** | Re-typing results, tubes without labels, reports that leave without a second check, patients calling "is my report ready?". |
| **Owner** | No view across branches, no idea why revenue dipped, empty slots and no-shows nobody follows up, and patient-data rules (DPDP Act) they can't prove they follow. |

The big hospital chains have built their own apps and EMRs. **The other 90%** (clinics with 2–50 doctors, single-specialty chains, diagnostic centres, 50–300-bed hospitals) can't afford to.

---

## 3. Who we sell to

| Buyer | Size | Edition | Monthly from | Their main reason to buy |
|---|---|---|---|---|
| **Clinic** | 1–10 doctors, one site | Clinic Starter / Pro | ₹4,999 / ₹9,999 | Online booking and a clean front desk |
| **Diagnostic centre** | Pathology lab, home collection | Diagnostic Starter / Pro | ₹6,999 / ₹12,999 | Reports online with QR proof, home collections, fewer "is my report ready?" calls |
| **Multi-specialty hospital** | 10–100 doctors, labs, 1–5 branches | Hospital Professional | ₹24,999 | One system from booking to report, AI for patients and doctors |
| **Hospital chain** | Several branches, own brand | Hospital Enterprise | ₹59,999 | Branch control, analytics, dedicated database, custom contract |
| **Specialty chain** (dental, eye, IVF) | Many small sites | Clinic + add-ons | custom | Memberships, branch-level control, one brand |

**The economic buyer** is the owner or the CEO/COO. **The champions** are the medical director (clinical safety, less paperwork) and the operations or front-office manager (queues, cash, no-shows). **The blocker** is usually the IT person or the accountant: bring the security and data answers in §7.

---

## 4. The story (tell it in this order)

### Act 1: Monday morning at a hospital without MediCare

*Illustrative.* It's 9 a.m. at a 40-doctor hospital in Gurugram. The reception phone has rung 60 times since 8. Twenty people stand at the desk, and three of them claim the same token number. Dr. Kapoor has a patient whose last reports are "somewhere at the Noida branch". A lab technician types a potassium value of 6.8 into a spreadsheet; nobody notices it is critical until the patient's son calls in the evening. The owner hears at month-end that revenue fell, but not why.

### Act 2: The same Monday on MediCare

- **8:00.** Dr. Kapoor's day list arrived by e-mail at 7. Her schedule shows 18 booked, 4 of them through the hospital's own website overnight and 2 through its AI assistant.
- **8:30.** A mother books her son with the pediatrician from her phone: finds the doctor by typing "fever and rash", picks 11:15, pays by UPI. The confirmation SMS has the hospital's name, not ours.
- **9:00.** At the desk, check-in is one click and a token number that can't be duplicated. A nurse records vitals and marks one patient **urgent**, and the doctor's queue shows it.
- **10:00.** In the consultation, the doctor sees a **summary of the patient's history** prepared before he walked in, every line linked to its source. She prescribes amoxicillin; MediCare stops her because the patient is **allergic to penicillin**. She changes it.
- **11:00.** The lab enters a potassium of 6.8. MediCare flags it **critical**, alerts the doctor at once, and **escalates** every 15 minutes (doctor, then pathologist, then the branch on-call) until someone acknowledges it.
- **12:00.** The patient gets an SMS: "Your report is ready." He opens it on his phone, asks the assistant what it means, and sees a QR code that proves the report is genuine.
- **18:00.** The desk closes the day: cash, UPI and card totals match, and refunds to hand back are listed.
- **Next morning.** The owner's brief: yesterday's visits, revenue by branch, no-shows. She asks in plain English, "Which branch had the most no-shows last week and why?" and gets an answer with numbers. Patients likely to miss tomorrow's visit have already been reminded.

### Act 3: Why this works for the hospital

1. **More booked slots.** Patients book 24×7 on the hospital's own site and through the AI assistant, rather than only by phone during desk hours.
2. **Fewer no-shows.** Reminders 24 h and 2 h before, outreach to patients at risk of missing, a waitlist that fills cancelled slots.
3. **Safer care.** Allergy and interaction checks, critical values that escalate until someone acknowledges them, signed and amendable notes with history.
4. **Less paperwork.** The AI scribe drafts the note from the consultation (with the patient's consent); the doctor checks and signs.
5. **Trust you can prove.** Patients see **who opened their record and why**. Every access is logged. Emergency access needs a reason and expires.
6. **One view of the business.** Dashboards across branches, a morning brief, and an assistant that answers questions about your own data.

---

## 5. Value by persona (what to say to whom)

| Persona | Say | Show |
|---|---|---|
| **Owner / CEO** | "See every branch on one screen. Book more slots, lose fewer patients, and prove you protect their data." | `/admin` overview, `/admin/analytics`, `/admin/ops` morning brief and question |
| **Medical director** | "No prescription goes out against a recorded allergy. No critical value waits until evening." | Consultation with an allergy refusal; `/lab/critical`; break-glass with the patient seeing it |
| **Doctor** | "Your history is summarised before you walk in. Your note is drafted while you talk." | `/doctor` Today, the copilot summary, the scribe draft |
| **Front office manager** | "A queue that runs itself, tokens nobody can argue with, and cash that matches at night." | `/desk` board, check-in, collections |
| **Lab head** | "Results checked against ranges, labels with barcodes, reports with QR proof, home collections on a board." | `/lab` worklist, labels, critical values, `/lab/home` |
| **Patient** (for the owner) | "Your hospital in their pocket, with your name on it." | `/care` on a phone: book, pay, report, timeline, assistant |
| **IT / accountant** | "Your data sits in its own database, encrypted, backed up every night and test-restored; you can export it any time." | §7 answers |

---

## 6. Demo script (20 minutes)

Use **Aarogya Hospitals** (http://aarogya.localhost:3400): it has 3 branches, 14 doctors, 20 patients and a week of bookings. Logins are in [APP-FLOWS-AND-LOGINS.md](APP-FLOWS-AND-LOGINS.md) §2. Before the demo: `mc dev` is running, Mailpit is open in a tab (http://localhost:61825) for OTPs, and you are signed in as each role in a separate browser profile.

| Min | Who you are | Do this | Say this |
|---|---|---|---|
| 0–2 | Visitor | Open aarogya.localhost:3400 | "This is Aarogya's own site: their name, colours and doctors. MediCare is invisible." |
| 2–5 | Patient (+91 98155 50000) | Search "chest pain" → Cardiology → pick a slot → OTP from Mailpit → pay online | "Booked and paid in under a minute, at 11 p.m. if they like." |
| 5–7 | Patient | `/care/assistant`: "book a cardiologist tomorrow morning" → "the second one" → Confirm | "The assistant proposes; the patient confirms. It never books on its own." |
| 7–9 | Receptionist (`desk@aarogya.test`) | `/desk`: the booking is on the board → check in → token | "Live board for every branch; tokens can't be duplicated." |
| 9–13 | Doctor (`ananya.sharma@aarogya.test`) | Queue → consult → summary → note, diagnosis → prescribe a medicine the patient is allergic to (refused) → sign | "The history is summarised with sources. The allergy check is a hard stop; overriding needs a reason, and it is recorded." |
| 13–15 | Patient | `/care/prescriptions`, `/care/timeline`, `/care/access-log` | "The patient sees exactly which doctor opened their record, and when." |
| 15–18 | Owner (`admin@aarogya.test`) | `/admin` overview → `/admin/analytics` → `/admin/ops`: ask about no-shows | "Every branch on one screen, and you can ask questions in plain English." |
| 18–20 | Owner | `/admin/settings`, `/admin/roles`, `/account/plan` | "You set the rules: cancellation cut-off, refunds, who can do what. Upgrade when you grow." |

For a **diagnostic centre**, swap minutes 9–15 for the lab flow on CityCare (`lab@citycare.test` → enter a critical value → `path@citycare.test` verifies → the patient sees the QR report).

Things to avoid in a demo: video consultations (not live), real WhatsApp messages and real SMS (Mailpit only), real payments (simulated gateway).

---

## 7. Why MediCare and not the alternatives

| Alternative | Its weakness | Our answer |
|---|---|---|
| **Paper, Excel and WhatsApp** | No history, no reminders, no proof of who saw what | Everything in one place, reminders built in, every access logged |
| **A booking-only app or a doctor marketplace** | The patient becomes the marketplace's customer; booking only, nothing after the visit | Your brand, your patients; booking → visit → lab → bill → follow-up |
| **Traditional hospital software (HIS)** installed on-site | Heavy, expensive set-up, a server in the basement, months to go live, a dated screen | Cloud, live in a day with self-serve signup and a setup wizard, modern screens, works on phones |
| **Building your own** | Costs crores and years; security and compliance are on you | Ready now, tested, and the same platform serves every customer |

**What is hard to copy**
1. **A separate database for every hospital.** One hospital's data can never appear in another's; it can be exported, moved or deleted on its own. Enterprise customers can have a **dedicated database server**.
2. **Record access by relationship.** A doctor sees a chart only when treating the patient, when the patient consents, or through audited emergency access. Every read is logged, and the patient can see the log.
3. **AI with guard rails.** The assistant uses the hospital's own information and the patient's own permissions. It drafts; people confirm. Emergencies are caught by fixed rules before the AI. Reports with a critical value are never "explained" by the AI.
4. **Sold in modules.** Start small (₹4,999), switch modules on as you grow. A plan change takes effect at once, without a new install.
5. **Operations a hospital never has to think about.** Encrypted nightly backups with a separate key per hospital, **restore drills** that prove the backup works, and moves between servers with about 5 seconds of read-only time.

---

## 8. Pricing and the commercial offer

### 8.1 List prices (monthly)

| Plan | Price | Includes |
|---|---|---|
| Clinic Starter | ₹4,999 | Directory, online booking, front desk, medical record, billing |
| Clinic Professional | ₹9,999 | The same with higher limits |
| Diagnostic Center Starter | ₹6,999 | Lab: catalogue, samples, results, reports, billing |
| Diagnostic Center Professional | ₹12,999 | + home collection |
| Hospital Professional | ₹24,999 | Clinic + lab + home collection + AI (concierge, report explainer, copilot, scribe) |
| Hospital Enterprise | ₹59,999 | Everything, higher limits, dedicated database option |

**Add-on modules:** analytics, the Ops agent, patient memberships, workflows (custom fields, forms, rules) and integrations (FHIR, webhooks, API keys, lab-machine connector). **Custom contracts:** per-doctor, per-branch or tiered pricing, discounts and waived set-up fees, approved by a second person at MediCare.

### 8.2 How to make the numbers work for the buyer

Use the hospital's own figures in front of them. A worked example with **illustrative** inputs:

| Input (ask the hospital) | Example |
|---|---|
| Doctors | 20 |
| Consultation fee | ₹600 |
| Visits per doctor per day | 20 |
| No-show rate today | 12% |
| Hours of desk time per day on phone bookings | 6 |

- Lost visits from no-shows: 20 doctors × 20 visits × 12% × ₹600 × 26 days ≈ **₹7.5 lakh a month**.
- If reminders, outreach and the waitlist **recover a quarter** of those (our target to measure in a pilot, not a proven figure): about **₹1.9 lakh a month**.
- Against Hospital Professional at ₹24,999, that pays for itself about **7 times over**, before counting desk time saved, online bookings outside desk hours, or lab reports that no longer need collecting in person.

Always say which numbers are the hospital's, which are assumptions, and that the pilot will measure them.

### 8.3 Offer

1. **Self-serve trial**: sign up at /signup, live the same day, trial period on any plan.
2. **Pilot (recommended for hospitals)**: 60 days at one branch. We agree three numbers up front (no-show rate, online share of bookings, report turnaround time) and measure them before and after.
3. **Roll-out**: the other branches, staff training by role (each role's screens fit on one page; see [APP-FLOWS-AND-LOGINS.md](APP-FLOWS-AND-LOGINS.md) §3).

---

## 9. Honest answers to common objections

| Objection | Answer |
|---|---|
| "Our data is safer on our own server." | Each hospital has its own database, encrypted, with its own backup key. Backups run every night and are **restored in a test every time** to prove they work. Every record access is logged. You can export everything at any time. Can your basement server show all that? |
| "Is it DPDP-compliant?" | It is built for it: consent to share records, a patient-visible access log, purpose-based access, data export for patients ("Download my data"), deletion with crypto-shredding after offboarding, and India data residency in the production design. Formal certification is a separate step we will do with you. |
| "Doctors won't type." | Most screens are one click. The scribe drafts the note from the conversation (with consent), and the summary means less scrolling. *The scribe needs the production AI key switched on; demo it as a preview until then.* |
| "Will AI give wrong medical advice?" | The patient assistant answers from **your** information, books only after the patient confirms, sends emergencies straight to 112/108, and never interprets a report with a critical value. Doctor tools draft; the doctor signs. |
| "We already have lab software." | Keep it: the **LIS connector** brings results in, and the FHIR API and webhooks connect other systems. Or move the lab onto MediCare. |
| "What if you shut down or we leave?" | Your data is in its own database and can be exported in full with every document. After you leave it is kept 30 days, then destroyed. |
| "Do you do video consultations?" | Not yet. It is on the roadmap; the booking side is ready to switch on. |
| "WhatsApp?" | The WhatsApp assistant is built; it goes live once your WhatsApp Business number is connected through Meta. |
| "Our branches have different rules." | Staff roles are per branch; a branch admin sees only their branch. Settings, roles and custom fields are yours to change. |

### What still needs accounts before go-live

| Item | Needs |
|---|---|
| Real SMS and OTP | An MSG91 account with DLT-registered templates |
| WhatsApp assistant | A WhatsApp Business account (Meta Cloud API) |
| Online payments and payouts | Razorpay keys (and Route for hospital payouts) |
| AI on the production model | A Google Gemini / Vertex AI key |
| Prescription safety in production | A licensed drug database (the current list is a starter set) |
| Hosting | A GCP project in India (the infrastructure code is written and validated) |
| Video consultations | Phase 28 (paused) |

---

## 10. Proof points you can quote today

- **Every hospital in its own database**, checked by an automated leak test of about 1,400 checks with **zero** leaks between hospitals.
- **No double booking**: slots are taken with a single atomic update, tested with many people booking the same slot at once.
- **Two-person rule** for plans and prices at MediCare: nobody approves their own change.
- **Backups proven by restore**: each backup is encrypted with that hospital's key and test-restored, and a damaged file is detected.
- **Moving a hospital to its own server** costs about **5 seconds** of read-only time, and nothing written is lost (checked row by row before switching).
- **Clinical safety rules**: allergy and interaction checks, critical-value escalation, and a visit can't be closed with an unsigned note unless the doctor deliberately chooses "sign later". Each has automated tests.

---

## 11. Elevator pitches

**10 seconds.** "MediCare puts your hospital online under your own name: booking, desk, doctors, lab and billing in one system, with AI that helps and never decides."

**30 seconds.** "Most hospitals still run on phone calls, registers and WhatsApp. MediCare gives you your own branded website and app where patients book and pay, a desk that runs the queue, doctors who see a patient's history and get safety checks as they prescribe, and a lab whose reports reach patients with a QR proof. You see every branch on one screen. Your data sits in its own encrypted database, and patients can see exactly who opened their record. Start at ₹4,999 a month and switch on more as you grow."

**For a hospital owner, one sentence.** "Fill more slots, lose fewer patients, and prove you protect their data, without buying a server or hiring IT."

/**
 * The words on MediCare's marketing site (docs/SEO-AND-ADS.md §1.2). Every claim here must be true of the product as
 * built (docs/APP-FLOWS-AND-LOGINS.md); what isn't built yet (video visits, ABDM) is not mentioned. Which plans include
 * a feature comes from the live plans, never from this file.
 */

export interface Feature {
  slug: string; icon: string; name: string; title: string; description: string;
  /** the plan modules that carry it (all of them must be in a plan for it to count; none in any plan = an add-on) */
  modules: string[];
  problem: string; points: string[]; segments: string[];
}

export const FEATURES: Feature[] = [
  {
    slug: 'online-booking', icon: 'calendar', name: 'Online booking',
    title: 'Online appointment booking for clinics and hospitals',
    description: 'Patients book a doctor on your own site, see the next free time, pay online or at the hospital, and get reminders. No marketplace commission.',
    modules: ['appointments'],
    problem: 'Patients who cannot get through on the phone book somewhere else, and booking marketplaces charge for patients who would have come to you anyway.',
    points: [
      'Your own booking site at your address, with your name and colours, listing each published doctor with the next free time.',
      'Book for oneself or a family member; pay online or at the hospital. An unpaid online booking is held for 10 minutes, and a late payment is refunded automatically.',
      'Reschedule and cancel within the cut-off you set; refunds follow your own policy.',
      'A waitlist when a doctor is full: the next patient is told when a slot opens.',
      'Reminders 24 hours and 2 hours before the visit, and a message to patients who missed it.',
      'Doctor and lab-test pages that search engines can find, with your hospital as the place to book.',
    ],
    segments: ['clinics', 'hospitals', 'chains'],
  },
  {
    slug: 'front-desk', icon: 'queue', name: 'Front desk and queue',
    title: 'OPD front desk software with queue tokens and counter payments',
    description: "Walk-ins, phone bookings, check-in with a queue token, cash, UPI and card at the counter, and end-of-day collections, live for every desk.",
    modules: ['front_desk'],
    problem: 'A paper register cannot tell three receptionists who is waiting, and the queue argues with the token slips.',
    points: [
      "Today's board per branch: booked, checked in, with the doctor, done, no-show, updated live on every desk.",
      'Find patients by phone, MRN or name; register a family under one phone number without duplicates.',
      'Check-in gives a queue token that is never duplicated, even with several desks.',
      'Collect cash, UPI or card with a reference, and print the receipt.',
      'End-of-day collections, and cash refunds to hand back.',
      'Nurses record vitals and a priority after check-in; the doctor sees them in the queue.',
    ],
    segments: ['clinics', 'hospitals', 'chains'],
  },
  {
    slug: 'medical-records', icon: 'clipboard', name: 'Medical records and prescriptions',
    title: 'EMR and e-prescription software with allergy and interaction checks',
    description: 'Visit notes with ICD-10 diagnoses, signed and amended with reasons; prescriptions checked against allergies and drug interactions; the whole record per patient.',
    modules: ['emr'],
    problem: 'Handwritten prescriptions miss allergies, notes are lost between visits, and nobody can tell who looked at a record.',
    points: [
      'Visit notes with the complaint and ICD-10 diagnoses; sign them, and amend later with a recorded reason.',
      "Every medicine is checked against the patient's allergies and drug interactions; a major interaction needs the doctor's reason.",
      'Prescriptions as a PDF, sent to the patient by SMS.',
      "The patient's whole history in one place: visits, prescriptions, lab reports and uploaded documents.",
      'A doctor opens a record only for a patient they treat or who gave consent; emergency access is time-limited, audited and shown to the patient.',
    ],
    segments: ['clinics', 'hospitals', 'chains'],
  },
  {
    slug: 'lab', icon: 'flask', name: 'Lab and reports',
    title: 'Pathology lab software: barcodes, results, verified reports with QR',
    description: 'Lab orders, barcode labels, results checked against reference ranges, critical-value alerts, and verified PDF reports that anyone can check with a QR code.',
    modules: ['diagnostics'],
    problem: 'Reports go out late or with typing errors, critical values wait in a pile, and patients keep calling to ask whether the report is ready.',
    points: [
      'A worklist by branch and day, including doctors\' orders waiting for a time.',
      'Barcode labels for every tube; reject a sample and ask for a recollection.',
      'Results are read and checked against reference ranges ("450 mg/dL" works) and flagged LOW, HIGH or CRITICAL.',
      'A critical value alerts the ordering doctor at once and escalates if nobody acknowledges it.',
      'The pathologist verifies and publishes; the PDF report carries a QR code that proves it is genuine.',
      'Patients get the report on their phone; tests and packages have their own pages with prices.',
    ],
    segments: ['diagnostic-centres', 'hospitals', 'chains'],
  },
  {
    slug: 'home-collection', icon: 'home', name: 'Home sample collection',
    title: 'Home sample collection software for labs and diagnostic centres',
    description: 'Patients book a home collection for a slot; the lab assigns phlebotomists, who collect the sample and the payment at the door.',
    modules: ['diagnostics', 'home_collection'],
    problem: 'Home visits run on phone calls and WhatsApp messages, and nobody knows which samples are still on the road.',
    points: [
      'Collection areas, slots and charges you set.',
      'Patients book a test or package at home online.',
      'Assign each visit to a phlebotomist, who sees the day\'s visits with addresses.',
      'Collect the sample and the payment at the door; "cannot visit" asks the patient for a new time.',
      'Overdue visits are flagged; a visit can be reassigned until a tube is collected.',
    ],
    segments: ['diagnostic-centres', 'hospitals'],
  },
  {
    slug: 'ai-assistant', icon: 'sparkles', name: 'AI assistant',
    title: 'AI assistant for hospitals: patient concierge, doctor copilot and scribe',
    description: 'A 24×7 assistant that answers patients and books with a Confirm card, a doctor copilot with cited summaries, and an AI scribe the doctor reviews.',
    modules: ['ai'],
    problem: 'The phone rings all day with the same questions, and doctors spend the consultation typing instead of listening.',
    points: [
      'Patients ask about timings, fees and departments, and book: nothing is booked until the patient presses Confirm.',
      'It explains a lab report in plain language, but never one with a critical value.',
      'Emergency words get the emergency numbers at once; "talk to a person" goes to the front desk.',
      'For doctors: a pre-visit summary of the record in which every line cites its source.',
      "AI scribe: with the patient's consent, the consultation becomes a draft note and prescription that the doctor edits and signs. The audio is deleted once the note is signed.",
      'It answers only from what you allow it to say.',
    ],
    segments: ['hospitals', 'chains'],
  },
  {
    slug: 'billing', icon: 'receipt', name: 'Billing and payments',
    title: 'Hospital billing software with online payments and refunds',
    description: 'Invoices, online and counter payments, refunds that follow your policy, receipts as PDF, and payouts to your bank account.',
    modules: ['billing'],
    problem: 'Refunds are worked out by hand, receipts are lost, and online payments do not match the register.',
    points: [
      'Invoices for visits, lab tests and memberships, with receipts as PDF.',
      'Online payments with refunds that follow your own cancellation policy, shown on the bill.',
      'Payouts to your bank account; changing it needs a one-time code and holds payouts for a while.',
      'End-of-day collections per desk.',
    ],
    segments: ['clinics', 'diagnostic-centres', 'hospitals', 'chains'],
  },
  {
    slug: 'analytics', icon: 'chart', name: 'Analytics and Ops agent',
    title: 'Hospital analytics dashboards and an AI Ops agent',
    description: "Revenue, visits, no-shows and lab turnaround by branch and doctor, from your hospital's own warehouse, and an Ops agent that answers questions in plain English.",
    modules: ['analytics'],
    problem: 'Owners find out about a bad month at the end of it, from a spreadsheet someone made by hand.',
    points: [
      'Dashboards for revenue, visits, no-shows and lab turnaround, by branch and doctor.',
      'Bookings by channel: online, desk, AI assistant, and the campaigns that brought patients.',
      'Ask "which branch had the most no-shows last week?" and get the answer with its numbers.',
      'A morning brief by e-mail.',
      'De-identified: reports never show patients\' names or clinical values.',
    ],
    segments: ['hospitals', 'chains'],
  },
];

export interface Segment {
  slug: string; name: string; title: string; description: string; headline: string; intro: string;
  /** the edition (display name) whose plans fit this buyer */
  pains: { pain: string; answer: string }[]; features: string[]; edition: string;
}

export const SEGMENTS: Segment[] = [
  {
    slug: 'clinics', name: 'Clinics', edition: 'Clinic',
    title: 'Clinic management software for Indian clinics · MediCare',
    description: 'Online booking under your clinic\'s name, a front desk with queue tokens, prescriptions with safety checks and billing. Start a free trial in minutes.',
    headline: 'For clinics with one to twenty doctors',
    intro: 'You want patients to book without calling, a calm waiting room and prescriptions you can read. You do not want an IT project.',
    pains: [
      { pain: 'The phone is busy and patients go elsewhere', answer: 'Patients book online at your own address and get reminders, so fewer miss the visit.' },
      { pain: 'The waiting room argues about turns', answer: 'Check-in gives a queue token, and the board is the same on every desk.' },
      { pain: 'Handwritten prescriptions', answer: 'Typed prescriptions, checked against allergies and drug interactions, sent to the patient by SMS.' },
      { pain: 'Setting up software takes weeks', answer: 'Sign up, confirm your e-mail, and the setup guide walks you through doctors and hours.' },
    ],
    features: ['online-booking', 'front-desk', 'medical-records', 'billing'],
  },
  {
    slug: 'diagnostic-centres', name: 'Diagnostic centres', edition: 'Diagnostic center',
    title: 'Diagnostic centre and pathology lab software · MediCare',
    description: 'Barcodes, results checked against ranges, critical-value alerts, verified PDF reports with QR codes, home sample collection and online test booking.',
    headline: 'For diagnostic centres and pathology labs',
    intro: 'You want reports out on time and right, home collections under control, and patients who stop calling to ask.',
    pains: [
      { pain: 'Typing errors and late reports', answer: 'Results are checked against reference ranges, and the pathologist verifies before anything is published.' },
      { pain: 'Critical values wait in a pile', answer: 'A critical value alerts the doctor at once and escalates if nobody acknowledges it.' },
      { pain: 'Fake or edited reports', answer: 'Every report has a QR code that shows whether it is genuine.' },
      { pain: 'Home visits run on WhatsApp', answer: 'Slots, phlebotomist assignment and payment at the door, with overdue visits flagged.' },
    ],
    features: ['lab', 'home-collection', 'billing'],
  },
  {
    slug: 'hospitals', name: 'Hospitals', edition: 'Multi-specialty hospital',
    title: 'Hospital management software for Indian hospitals · MediCare',
    description: 'Booking, front desk, medical records, lab, billing, AI assistance and analytics in one subscription, with your own secure database.',
    headline: 'For multi-specialty hospitals',
    intro: 'Every department has its own register and its own software, and nobody sees the whole picture.',
    pains: [
      { pain: 'Separate systems for OPD, lab and billing', answer: 'One system: the visit, the lab order, the report and the bill belong to the same patient.' },
      { pain: 'Doctors type instead of listening', answer: 'The AI scribe drafts the note and prescription; the doctor edits and signs.' },
      { pain: 'Who saw this record?', answer: 'Every access is logged, and patients can see who opened their record and why.' },
      { pain: 'Numbers arrive at month end', answer: 'Dashboards and an Ops agent answer questions about yesterday this morning.' },
    ],
    features: ['online-booking', 'front-desk', 'medical-records', 'lab', 'ai-assistant', 'analytics'],
  },
  {
    slug: 'chains', name: 'Clinic and hospital chains', edition: 'Multi-specialty hospital',
    title: 'Software for multi-branch clinic and hospital chains · MediCare',
    description: 'Branches, doctors across branches, branch admins who see only their branch, and dashboards that compare branches. One patient record across the chain.',
    headline: 'For chains with several branches',
    intro: 'Each branch runs its own way, and head office only sees what branches send.',
    pains: [
      { pain: 'Branch managers see everything, or nothing', answer: 'Branch admins see and manage only their branch; the server enforces it, not just the menu.' },
      { pain: 'A patient is a stranger at the next branch', answer: 'One record across all branches, with each access logged.' },
      { pain: 'Comparing branches by spreadsheet', answer: 'Dashboards by branch and doctor, from the same data.' },
      { pain: 'Patients cannot find the nearest branch', answer: 'Each branch has its own page with address, map and doctors, which search engines can find.' },
    ],
    features: ['online-booking', 'front-desk', 'analytics', 'billing'],
  },
];

export const SECURITY: { title: string; text: string }[] = [
  { title: 'Your own database', text: "Every hospital has its own database. One hospital's data is never in another's tables, and automated tests check it." },
  { title: 'Encrypted, field by field', text: 'Sensitive fields are encrypted with a key for your hospital, on top of encryption at rest. Deleting a hospital destroys its keys.' },
  { title: 'Who opened which record', text: 'Every access to a medical record is logged with the reason. Patients can see the log themselves, including emergency access.' },
  { title: 'Access by role and branch', text: 'Roles you can edit, branch-scoped admins, and nobody can grant a permission they do not hold. Doctors need a treating relationship or the patient\'s consent.' },
  { title: "Patients' rights", text: 'Patients download their data, give and withdraw consent to share their record, and see who accessed it.' },
  { title: 'Backups and leaving', text: 'Backups with tested restores. If you leave, you get an export of your data; a deleted hospital is kept for 30 days, then erased.' },
  { title: 'No ad tracking on patient pages', text: "We never put advertising pixels on your patients' pages, so nothing about their health goes to ad platforms." },
];

export const PRICING_FAQ: { q: string; a: string }[] = [
  { q: 'Is there a free trial?', a: 'Yes. Every self-serve plan starts with a free trial, and no card is needed to start.' },
  { q: 'Are prices with GST?', a: 'Prices are per month before GST (18%).' },
  { q: 'Can I change plans later?', a: 'Yes. Upgrade or downgrade from your account page; add-ons such as more doctors or SMS can be added at any time.' },
  { q: 'What happens to my data if I leave?', a: "It is your data. You get an export; a deleted hospital is kept for 30 days and then erased, along with its encryption keys." },
  { q: 'Do patients pay a booking fee?', a: 'No booking commission: patients book on your own site, and you set the fees.' },
  { q: 'Can I use my own domain?', a: 'Yes, on the Enterprise plan: your booking site runs at your own address, verified through your DNS.' },
  { q: 'Do I need to install anything?', a: 'No. MediCare runs in the browser on computers and phones.' },
];

export interface Article { slug: string; title: string; description: string; published: string; feature: string; body: { h?: string; p?: string; list?: string[] }[] }

/**
 * Practical guides only. Articles on law (DPDP, ABDM) or clinical topics wait for a review by a lawyer or a doctor
 * (docs/SEO-AND-ADS.md §1.2) and are not published here.
 */
export const ARTICLES: Article[] = [
  {
    slug: 'cut-opd-no-shows', title: 'How to cut OPD no-shows: reminders, waitlists and outreach', published: '2026-11-10', feature: 'online-booking',
    description: 'Why patients miss appointments, and five changes that fill the empty slots: easy rescheduling, two reminders, a waitlist, prepayment and a follow-up.',
    body: [
      { p: 'A missed appointment costs twice: the doctor\'s time is lost, and another patient could have had the slot. Most no-shows are not patients who changed their mind; they forgot, could not reach you to cancel, or found an earlier time elsewhere.' },
      { h: '1. Make cancelling and rescheduling easy', p: 'A patient who cannot get through on the phone to cancel simply does not come. Let patients reschedule or cancel online within a cut-off you choose, and the slot goes back on sale.' },
      { h: '2. Send two reminders', p: 'One the day before, so the patient can plan, and one two hours before, so they leave on time. Short messages with the doctor\'s name, the time and a link to reschedule work best.' },
      { h: '3. Keep a waitlist', p: 'When a doctor is full, take names. When someone cancels, tell the next patient straight away: a cancellation becomes a visit instead of a gap.' },
      { h: '4. Ask for payment when booking, where it fits', p: 'A paid booking is a commitment. Offer both "pay online" and "pay at the hospital", and make the refund rules clear before the patient pays.' },
      { h: '5. Follow up the ones who missed', p: 'A message after a missed visit, with a link to book again, brings many of them back, and tells you why they did not come.' },
      { h: 'Measure it', p: 'Count no-shows by doctor, branch and day of the week each week. The pattern usually points to the fix: a doctor who runs late, a branch that is hard to reach, or Monday mornings.' },
    ],
  },
  {
    slug: 'online-booking-without-marketplace', title: 'Online booking for your clinic without a marketplace commission', published: '2026-11-10', feature: 'online-booking',
    description: 'Marketplaces bring visibility but take a cut and own the patient relationship. How to take bookings on your own site and still be found on Google.',
    body: [
      { p: 'Doctor marketplaces solve a real problem: patients search, and the marketplace shows up. The cost is a commission or a listing fee, patients who belong to the marketplace rather than to you, and a page about your doctor that you do not control.' },
      { h: 'What you need instead', list: [
        'A booking site at your own address, with each doctor\'s real free times.',
        'A page for each doctor, specialty, branch and test that search engines can find: the doctor\'s name, specialty, languages, qualifications and the branch address.',
        'Online payment, reminders and easy rescheduling, so booking with you is as easy as on a marketplace.',
        'A Google Business Profile for each branch that links to that branch\'s page.',
      ] },
      { h: 'How patients find you', p: 'People search for a doctor\'s name, a specialty plus a place ("cardiologist in Noida"), or a test ("HbA1c test price"). A page per doctor, per specialty and per test, each with its own title and description, is what lets search engines match those searches to your site.' },
      { h: 'Keep the marketplace while you switch', p: 'You do not have to leave a marketplace on day one. Put your own booking link on your Google profile, prescriptions and receipts, and watch the share of bookings that come straight to you grow.' },
    ],
  },
  {
    slug: 'paper-register-to-software', title: 'Paper register to software: a 30-day plan for a 10-doctor clinic', published: '2026-11-10', feature: 'front-desk',
    description: 'A week-by-week plan to move a clinic from paper registers to software without stopping the OPD: set-up, the front desk, doctors, then patients.',
    body: [
      { p: 'Clinics put off software because they fear a bad week. Done in steps, the OPD never stops.' },
      { h: 'Week 1: set up', list: ['Branches, timings and each doctor\'s weekly hours.', 'Fees, the cancellation cut-off and the refund rule.', 'Staff logins with the right role for each person.'] },
      { h: 'Week 2: the front desk first', p: 'Start with check-in and queue tokens at the desk while doctors keep writing on paper. Receptionists learn on real patients, and the queue gets calmer at once.' },
      { h: 'Week 3: doctors', p: 'Doctors start typing notes and prescriptions, one or two doctors first. The ones who like it show the others.' },
      { h: 'Week 4: patients', p: 'Switch on online booking and reminders, and put the booking link on your Google profile, prescriptions and receipts.' },
      { h: 'What to measure', list: ['Waiting time from check-in to the doctor.', 'The share of bookings made online.', 'No-shows per week.'] },
    ],
  },
];

export const featureBySlug = (slug: string) => FEATURES.find((f) => f.slug === slug);
export const segmentBySlug = (slug: string) => SEGMENTS.find((s) => s.slug === slug);
export const articleBySlug = (slug: string) => ARTICLES.find((a) => a.slug === slug);

/** Every page of the marketing site, for the sitemap. */
export const MARKETING_PATHS = [
  '/', '/pricing', '/signup', '/demo', '/features', '/security', '/resources',
  ...FEATURES.map((f) => `/features/${f.slug}`), ...SEGMENTS.map((s) => `/for/${s.slug}`), ...ARTICLES.map((a) => `/resources/${a.slug}`),
];

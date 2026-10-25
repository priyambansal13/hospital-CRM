/**
 * What every hospital's assistant knows on day one. The hospital edits these in Admin → Assistant knowledge (the
 * defaults are seeded once, never overwritten). Facts only, no medical advice: the output policy refuses advice even
 * when it comes from here.
 */
export interface DefaultArticle { ref: string; source: 'FAQ' | 'POLICY' | 'EMERGENCY' | 'TEST_PREP'; title: string; body: string; language?: string }

export const DEFAULT_ARTICLES: DefaultArticle[] = [
  {
    ref: 'emergency', source: 'EMERGENCY', title: 'Emergency department',
    body: 'Our emergency department is open 24 hours a day, every day of the year, including holidays. Walk in or come by ambulance; no appointment is needed.',
  },
  {
    ref: 'visiting-hours', source: 'FAQ', title: 'Visiting hours',
    body: 'Visiting hours for admitted patients are 10:00 am to 12:00 noon and 5:00 pm to 7:00 pm, every day.\n\nOne visitor at a time per patient (two on Sundays in general wards). ICU visits are 15 minutes at 11:00 am and 6:00 pm, one visitor only. Children under 12 cannot visit the ICU. Visitors need a visitor pass from the reception desk.',
  },
  {
    ref: 'visiting-hours-hi', source: 'FAQ', title: 'मिलने का समय', language: 'hi',
    body: 'भर्ती मरीज़ों से मिलने का समय रोज़ सुबह 10 से दोपहर 12 बजे और शाम 5 से 7 बजे तक है। एक समय में एक ही व्यक्ति मिल सकता है। ICU में मिलने का समय सुबह 11 और शाम 6 बजे, 15 मिनट के लिए है। विज़िटर पास रिसेप्शन से लें।',
  },
  {
    ref: 'opd-timings', source: 'FAQ', title: 'Outpatient (OPD) timings',
    body: 'Outpatient consultations are Monday to Saturday, 9:00 am to 8:00 pm, and Sunday 9:00 am to 1:00 pm. Each doctor\'s own days and times are on their profile under "Find a doctor", where you can book online.',
  },
  {
    ref: 'lab-timings', source: 'FAQ', title: 'Lab and sample collection timings',
    body: 'The lab collects samples from 7:00 am to 7:00 pm every day. Tests that need fasting are best done between 7:00 and 10:00 am. Book a time under "Lab tests"; home sample collection is available in some areas.',
  },
  {
    ref: 'fasting', source: 'TEST_PREP', title: 'Fasting before blood tests',
    body: 'When a test needs fasting, do not eat or drink anything except plain water for the number of hours shown for that test (usually 8 to 12 hours). Overnight fasting with a morning sample is easiest. Tea, coffee, juice, chewing gum and smoking break the fast. Tests that do not say fasting can be done at any time.',
  },
  {
    ref: 'reports', source: 'FAQ', title: 'Getting your lab reports',
    body: 'Reports are ready within the time shown for each test, mostly the same day. You get an SMS when your report is ready, and you can download it under "My lab tests". The doctor who ordered the test sees it at the same time.',
  },
  {
    ref: 'payments', source: 'FAQ', title: 'Payments and fees',
    body: 'Consultation fees are shown on each doctor\'s profile. You can pay online when booking (UPI, cards, net banking) or at the hospital in cash, card or UPI. Bills and receipts are under "My bills".',
  },
  {
    ref: 'insurance', source: 'FAQ', title: 'Insurance and cashless treatment',
    body: 'Cashless treatment is available for admissions with most major insurers and TPAs. Bring your insurance card or policy number and a photo ID to the insurance desk at least one day before a planned admission. Outpatient consultations are paid by the patient and can be claimed later if your policy allows.',
  },
  {
    ref: 'cancellation', source: 'POLICY', title: 'Cancelling or changing an appointment',
    body: 'You can cancel or move an appointment online under "My appointments" until a few hours before it (the hospital sets how many). After that, please call the hospital. If you paid online, the refund goes back to the same account within 5 to 7 working days.',
  },
  {
    ref: 'what-to-bring', source: 'POLICY', title: 'What to bring to your visit',
    body: 'Please bring a photo ID, your appointment number, earlier prescriptions and reports, and your insurance card if you have one. Arrive 15 minutes early for your first visit to register.',
  },
  {
    ref: 'parking', source: 'FAQ', title: 'Parking and getting here',
    body: 'Parking is available at the hospital; the first 2 hours are free for patients (get your ticket stamped at reception). Wheelchairs are available at the main entrance; ask the security desk.',
  },
  {
    ref: 'records-privacy', source: 'POLICY', title: 'Your medical records and privacy',
    body: 'Your records are private to you and the doctors treating you. You can see who opened your record under "Record access", and share it with another doctor for a limited time under "Sharing". The assistant never sees your medical records.',
  },
];

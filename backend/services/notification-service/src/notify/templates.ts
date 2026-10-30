/**
 * Default templates copied into every hospital (editable in Admin → Messages). SMS stays short and never contains
 * clinical details (no diagnosis, no test names: docs/LLD.md §14). {{var}} placeholders; unknown vars render empty.
 */
export interface DefaultTemplate { key: string; channel: 'SMS' | 'EMAIL'; language: 'en' | 'hi'; subject?: string; body: string }

const en: DefaultTemplate[] = [
  { key: 'appointment_confirmed', channel: 'SMS', language: 'en', body: '{{hospital}}: appointment {{appointmentNo}} confirmed for {{patientName}} with {{doctorName}} on {{when}} at {{where}}. Manage: {{link}}' },
  { key: 'appointment_confirmed', channel: 'EMAIL', language: 'en', subject: 'Appointment confirmed: {{when}} with {{doctorName}}', body: 'Hello,\n\nYour appointment is confirmed.\n\nPatient: {{patientName}}\nDoctor: {{doctorName}}\nWhen: {{when}}\nWhere: {{where}}\nAppointment no.: {{appointmentNo}}\nFee: {{fee}}\n\nTo reschedule or cancel, visit {{link}} (online changes close {{cutoff}} before).\n\n{{hospital}}' },
  { key: 'appointment_rescheduled', channel: 'SMS', language: 'en', body: '{{hospital}}: appointment moved. {{patientName}} with {{doctorName}} is now on {{when}} at {{where}} (no. {{appointmentNo}}).' },
  { key: 'appointment_rescheduled', channel: 'EMAIL', language: 'en', subject: 'Appointment rescheduled to {{when}}', body: 'Hello,\n\nYour appointment has been moved.\n\nPatient: {{patientName}}\nDoctor: {{doctorName}}\nNew time: {{when}}\nWhere: {{where}}\nAppointment no.: {{appointmentNo}}\n\n{{hospital}}' },
  { key: 'appointment_cancelled', channel: 'SMS', language: 'en', body: '{{hospital}}: appointment {{appointmentNo}} on {{when}} with {{doctorName}} is cancelled. Book again: {{link}}' },
  { key: 'appointment_cancelled', channel: 'EMAIL', language: 'en', subject: 'Appointment cancelled', body: 'Hello,\n\nThe appointment for {{patientName}} with {{doctorName}} on {{when}} (no. {{appointmentNo}}) is cancelled.\n\nBook again any time: {{link}}\n\n{{hospital}}' },
  { key: 'appointment_cancelled_doctor', channel: 'SMS', language: 'en', body: '{{hospital}}: sorry, {{doctorName}} is unavailable on {{date}}. Appointment {{appointmentNo}} is cancelled. Please rebook: {{link}}' },
  { key: 'appointment_cancelled_doctor', channel: 'EMAIL', language: 'en', subject: 'Your appointment on {{date}} is cancelled', body: 'Hello,\n\nWe are sorry: {{doctorName}} is unavailable on {{date}}, so the appointment for {{patientName}} at {{when}} (no. {{appointmentNo}}) is cancelled.\n\nPlease choose another time: {{link}}\n\n{{hospital}}' },
  { key: 'reminder_24h', channel: 'SMS', language: 'en', body: '{{hospital}}: reminder, {{patientName}} sees {{doctorName}} tomorrow, {{when}} at {{where}}. Need to change? {{link}}' },
  { key: 'reminder_24h', channel: 'EMAIL', language: 'en', subject: 'Reminder: appointment tomorrow at {{time}}', body: 'Hello,\n\nA reminder that {{patientName}} has an appointment with {{doctorName}} on {{when}} at {{where}} (no. {{appointmentNo}}).\n\nPlease arrive 10 minutes early. To change it, visit {{link}}.\n\n{{hospital}}' },
  { key: 'reminder_2h', channel: 'SMS', language: 'en', body: '{{hospital}}: {{patientName}} sees {{doctorName}} today at {{time}}, {{where}}. Please arrive 10 minutes early.' },
  { key: 'waitlist_slot_available', channel: 'SMS', language: 'en', body: '{{hospital}}: a time opened up with {{doctorName}} on {{date}}. Book quickly: {{link}}' },
  { key: 'payment_received', channel: 'SMS', language: 'en', body: '{{hospital}}: payment of {{amount}} received for {{patientName}} ({{invoiceNo}}). Receipt: {{link}}' },
  { key: 'payment_received', channel: 'EMAIL', language: 'en', subject: 'Payment received: {{invoiceNo}}', body: 'Hello,\n\nWe received your payment of {{amount}} for {{patientName}} ({{method}}).\n\nInvoice: {{invoiceNo}}\nDownload your receipt: {{link}}\n\n{{hospital}}' },
  { key: 'prescription_ready', channel: 'SMS', language: 'en', body: '{{hospital}}: prescription {{prescriptionNo}} from {{doctorName}} for {{patientName}} is ready. View: {{link}}' },
  { key: 'prescription_ready', channel: 'EMAIL', language: 'en', subject: 'Your prescription from {{doctorName}}', body: 'Hello,\n\n{{doctorName}} has issued prescription {{prescriptionNo}} for {{patientName}}.\n\nView or download it securely: {{link}}\n\n{{hospital}}' },
  { key: 'lab_booked', channel: 'SMS', language: 'en', body: '{{hospital}}: lab visit booked for {{patientName}} on {{when}} at {{where}} ({{orderNo}}). {{prep}}' },
  { key: 'lab_booked', channel: 'EMAIL', language: 'en', subject: 'Lab visit booked: {{when}}', body: 'Hello,\n\nThe lab visit for {{patientName}} is booked for {{when}} at {{where}}.\nOrder no.: {{orderNo}}\n\nBefore you come: {{prep}}\n\nDetails: {{link}}\n\n{{hospital}}' },
  { key: 'lab_ordered', channel: 'SMS', language: 'en', body: '{{hospital}}: {{doctorName}} has requested lab tests for {{patientName}}. Pick a collection time: {{link}}' },
  { key: 'lab_recollect', channel: 'SMS', language: 'en', body: '{{hospital}}: we need a new sample for {{patientName}} ({{orderNo}}). Please visit the lab at your convenience; there is no extra charge.' },
  { key: 'lab_report_ready', channel: 'SMS', language: 'en', body: '{{hospital}}: a new document for {{patientName}} ({{orderNo}}) is ready{{amendedNote}}. View it securely: {{link}}' },
  { key: 'lab_report_ready', channel: 'EMAIL', language: 'en', subject: 'Lab report ready: {{orderNo}}', body: 'Hello,\n\nThe lab report for {{patientName}} ({{orderNo}}) is ready{{amendedNote}}.\n\nView and download it securely: {{link}}\nPlease discuss the results with your doctor.\n\n{{hospital}}' },
  { key: 'lab_report_ready_doctor', channel: 'EMAIL', language: 'en', subject: 'Report ready: {{patientName}} ({{orderNo}})', body: 'Dr.,\n\nThe lab report for {{patientName}} ({{patientMrn}}, {{orderNo}}) you ordered is verified{{amendedNote}}. {{flagsLine}}\n\nOpen MediCare: {{link}}\n\n{{hospital}}' },
  { key: 'lab_critical_value', channel: 'EMAIL', language: 'en', subject: 'CRITICAL lab value: {{patientName}} ({{patientMrn}})', body: 'URGENT\n\nA critical value was entered for {{patientName}} ({{patientMrn}}, order {{orderNo}}): {{testName}}, {{parameter}}.\n\nOpen MediCare now to see the value and acknowledge: {{link}}\n\n{{hospital}} lab' },
  { key: 'lab_critical_escalated', channel: 'EMAIL', language: 'en', subject: 'ESCALATED critical lab value: {{patientName}} ({{patientMrn}})', body: 'URGENT: not acknowledged for {{minutesOpen}} minutes\n\nA critical value for {{patientName}} ({{patientMrn}}, order {{orderNo}}): {{testName}}, {{parameter}}. {{orderedByLine}}\n\n{{action}}\nOpen MediCare: {{link}}\n\n{{hospital}} lab' },
  { key: 'home_visit_assigned', channel: 'SMS', language: 'en', body: '{{hospital}}: {{collector}} will collect the sample for {{patientName}} at home on {{when}} ({{orderNo}}). Details: {{link}}' },
  { key: 'home_visit_assigned', channel: 'EMAIL', language: 'en', subject: 'Home sample collection on {{when}}', body: 'Hello,\n\n{{collector}} from {{hospital}} will come to collect the sample for {{patientName}} on {{when}} (order {{orderNo}}).\nPlease keep the preparation instructions in mind; you can pay the collector if you have not paid yet.\n\nDetails: {{link}}\n\n{{hospital}}' },
  { key: 'home_visit_en_route', channel: 'SMS', language: 'en', body: '{{hospital}}: {{collector}} is on the way to collect the sample for {{patientName}} ({{orderNo}}).' },
  { key: 'home_visit_missed', channel: 'SMS', language: 'en', body: '{{hospital}}: we could not collect the sample for {{patientName}} today ({{orderNo}}). Please pick a new time: {{link}}' },
  // MediCare's own messages to the hospital's account owner (subscription, invoices, usage): wording composed by the planner
  { key: 'billing_notice_staff', channel: 'EMAIL', language: 'en', subject: '{{subject}}', body: 'Hello,\n\n{{message}}\n\nSubscription, invoices and usage: {{link}}\n\nMediCare billing' },
  { key: 'home_visit_assigned_staff', channel: 'EMAIL', language: 'en', subject: 'Home collection {{when}} ({{orderNo}})', body: 'Hello {{collector}},\n\nA home sample collection was assigned to you: {{when}}, pincode {{pincode}} (order {{orderNo}}).\n\nAddress, tubes and preparation: {{link}}\n\n{{hospital}} lab' },
  { key: 'refund_initiated', channel: 'SMS', language: 'en', body: '{{hospital}}: refund of {{amount}} for {{invoiceNo}} is on its way. It reaches your account in 5-7 working days.' },
  { key: 'refund_initiated', channel: 'EMAIL', language: 'en', subject: 'Refund of {{amount}} on its way', body: 'Hello,\n\nWe have refunded {{amount}} for {{patientName}} (invoice {{invoiceNo}}). Reason: {{reason}}.\n\nBanks usually take 5-7 working days to show it in your account.\nDetails: {{link}}\n\n{{hospital}}' },
  { key: 'waitlist_slot_available', channel: 'EMAIL', language: 'en', subject: 'A time opened up on {{date}}', body: 'Hello,\n\nA time just opened up with {{doctorName}} on {{date}}. Times go fast, so book now: {{link}}\n\n{{hospital}}' },
];

const hi: DefaultTemplate[] = [
  { key: 'appointment_confirmed', channel: 'SMS', language: 'hi', body: '{{hospital}}: {{patientName}} की {{doctorName}} के साथ अपॉइंटमेंट {{appointmentNo}} {{when}} को {{where}} में पक्की है। बदलाव: {{link}}' },
  { key: 'appointment_rescheduled', channel: 'SMS', language: 'hi', body: '{{hospital}}: अपॉइंटमेंट बदली गई। {{patientName}} अब {{when}} को {{doctorName}} से {{where}} में मिलेंगे (नं. {{appointmentNo}})।' },
  { key: 'appointment_cancelled', channel: 'SMS', language: 'hi', body: '{{hospital}}: {{when}} की अपॉइंटमेंट {{appointmentNo}} रद्द कर दी गई है। दोबारा बुक करें: {{link}}' },
  { key: 'appointment_cancelled_doctor', channel: 'SMS', language: 'hi', body: '{{hospital}}: क्षमा करें, {{doctorName}} {{date}} को उपलब्ध नहीं हैं। अपॉइंटमेंट {{appointmentNo}} रद्द है। दोबारा बुक करें: {{link}}' },
  { key: 'reminder_24h', channel: 'SMS', language: 'hi', body: '{{hospital}}: याद दिलाना, {{patientName}} की कल {{when}} को {{doctorName}} से {{where}} में अपॉइंटमेंट है। बदलाव: {{link}}' },
  { key: 'reminder_2h', channel: 'SMS', language: 'hi', body: '{{hospital}}: {{patientName}} की आज {{time}} बजे {{doctorName}} से अपॉइंटमेंट है, {{where}}। कृपया 10 मिनट पहले आएँ।' },
  { key: 'waitlist_slot_available', channel: 'SMS', language: 'hi', body: '{{hospital}}: {{date}} को {{doctorName}} के साथ समय खाली हुआ है। जल्दी बुक करें: {{link}}' },
  { key: 'payment_received', channel: 'SMS', language: 'hi', body: '{{hospital}}: {{patientName}} के लिए {{amount}} का भुगतान मिल गया ({{invoiceNo}})। रसीद: {{link}}' },
  { key: 'prescription_ready', channel: 'SMS', language: 'hi', body: '{{hospital}}: {{patientName}} के लिए {{doctorName}} का पर्चा {{prescriptionNo}} तैयार है। देखें: {{link}}' },
  { key: 'lab_booked', channel: 'SMS', language: 'hi', body: '{{hospital}}: {{patientName}} की लैब जाँच {{when}} को {{where}} में बुक है ({{orderNo}})। {{prep}}' },
  { key: 'lab_ordered', channel: 'SMS', language: 'hi', body: '{{hospital}}: {{doctorName}} ने {{patientName}} के लिए लैब जाँच लिखी है। सैंपल का समय चुनें: {{link}}' },
  { key: 'lab_recollect', channel: 'SMS', language: 'hi', body: '{{hospital}}: {{patientName}} ({{orderNo}}) का नया सैंपल चाहिए। कृपया लैब आएँ; कोई अतिरिक्त शुल्क नहीं।' },
  { key: 'lab_report_ready', channel: 'SMS', language: 'hi', body: '{{hospital}}: {{patientName}} ({{orderNo}}) का नया दस्तावेज़ तैयार है। सुरक्षित रूप से देखें: {{link}}' },
  { key: 'home_visit_assigned', channel: 'SMS', language: 'hi', body: '{{hospital}}: {{collector}} {{when}} को घर पर {{patientName}} का सैंपल लेने आएँगे ({{orderNo}})। विवरण: {{link}}' },
  { key: 'home_visit_en_route', channel: 'SMS', language: 'hi', body: '{{hospital}}: {{collector}} {{patientName}} का सैंपल लेने के लिए रास्ते में हैं ({{orderNo}})।' },
  { key: 'home_visit_missed', channel: 'SMS', language: 'hi', body: '{{hospital}}: आज {{patientName}} का सैंपल नहीं लिया जा सका ({{orderNo}})। कृपया नया समय चुनें: {{link}}' },
  { key: 'refund_initiated', channel: 'SMS', language: 'hi', body: '{{hospital}}: {{invoiceNo}} के {{amount}} वापस भेज दिए गए हैं। 5-7 कार्य दिवसों में आपके खाते में आ जाएँगे।' },
];

export const DEFAULT_TEMPLATES = [...en, ...hi];

/** Messages to hospital staff: email only (no SMS template on purpose). */
export const STAFF_ONLY_KEYS = new Set(['lab_report_ready_doctor', 'lab_critical_value', 'lab_critical_escalated', 'home_visit_assigned_staff', 'billing_notice_staff']);

/** {{var}} replacement; missing values render as empty strings. */
export function render(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

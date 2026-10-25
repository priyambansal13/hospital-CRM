import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

type Rx = {
  prescriptionNo: string; issuedAt: string | Date; followUpOn: string | null; advice: string | null;
  doctor: { name: string }; patient: { name: string; mrn: string; age: number | null; gender: string | null };
  diagnoses: { code: string | null; description: string }[];
  items: { drugName: string; strength: string | null; form: string | null; dosage: string; durationDays: number | null; instructions: string | null }[];
};

const ascii = (s: string) => s.replace(/[^\x20-\x7E]/g, '-');
const day = (d: string | Date) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(d));

/** Prescription on the hospital's letterhead (A4). */
export async function prescriptionPdf(hospital: string, rx: Rx) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${rx.prescriptionNo} · ${hospital}`);
  pdf.setProducer('MediCare');
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.07, 0.09, 0.15);
  const muted = rgb(0.36, 0.39, 0.45);
  const brand = rgb(0.06, 0.46, 0.43);
  let y = 790;
  const text = (s: string, x: number, size = 10, f = font, color = ink) => page.drawText(ascii(s), { x, y, size, font: f, color });
  const right = (s: string, xr: number, size = 10, f = font) => page.drawText(ascii(s), { x: xr - f.widthOfTextAtSize(ascii(s), size), y, size, font: f, color: ink });
  const wrap = (s: string, x: number, width: number, size = 10) => {
    for (const para of ascii(s).split('\n')) {
      let line = '';
      for (const w of para.split(' ')) {
        const next = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(next, size) > width) { text(line, x, size); y -= size + 4; line = w; } else line = next;
      }
      text(line, x, size); y -= size + 4;
    }
  };

  text(hospital, 50, 18, bold, brand);
  right(rx.prescriptionNo, 545, 11, bold);
  y -= 18; text(rx.doctor.name, 50, 11, bold); right(day(rx.issuedAt), 545);
  y -= 12; page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 1, color: brand });
  y -= 24; text('Patient', 50, 9, bold, muted);
  y -= 15; text(`${rx.patient.name}`, 50, 12, bold);
  right(`${rx.patient.age ?? '-'} y${rx.patient.gender ? ` / ${rx.patient.gender[0]}` : ''} · MRN ${rx.patient.mrn}`, 545);
  if (rx.diagnoses.length) {
    y -= 26; text('Diagnosis', 50, 9, bold, muted);
    for (const d of rx.diagnoses) { y -= 15; text(`${d.description}${d.code ? ` (${d.code})` : ''}`, 58); }
  }
  y -= 34; text('Rx', 50, 20, bold, brand);
  y -= 8;
  rx.items.forEach((i, n) => {
    y -= 22;
    text(`${n + 1}. ${i.drugName}${i.strength ? ` ${i.strength}` : ''}${i.form ? ` (${i.form})` : ''}`, 58, 11, bold);
    y -= 15;
    text(`${i.dosage}${i.durationDays ? `  x ${i.durationDays} day${i.durationDays === 1 ? '' : 's'}` : ''}${i.instructions ? `  · ${i.instructions}` : ''}`, 72, 10, font, muted);
  });
  if (rx.advice) { y -= 32; text('Advice', 50, 9, bold, muted); y -= 15; wrap(rx.advice, 58, 480); }
  if (rx.followUpOn) { y -= 16; text(`Follow up on ${day(rx.followUpOn)}`, 50, 10, bold); }
  y = 90; page.drawLine({ start: { x: 380, y: y + 14 }, end: { x: 545, y: y + 14 }, thickness: 0.6, color: muted });
  right(rx.doctor.name, 545, 10, bold);
  y = 76; right(`Issued electronically on ${day(rx.issuedAt)}`, 545, 8);
  y = 50; text('Valid only with the prescription number. Verify at the hospital.', 50, 8, font, muted);
  return Buffer.from(await pdf.save());
}

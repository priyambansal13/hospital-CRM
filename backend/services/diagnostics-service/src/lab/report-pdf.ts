import { toBuffer } from 'bwip-js/node';
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib';

export interface ReportInput {
  hospital: string; branch: string; orderNo: string; version: number; verifyUrl: string; verifyCode: string;
  patient: { name: string; mrn: string; age: number | null; sex: string | null };
  referredBy: string | null; collectedAt: Date | null; reportedAt: Date;
  verifiedBy: string; amendment: { replaces: number; reason: string } | null;
  tests: { name: string; results: { parameter: string; value: string; unit: string | null; refLow: number | null; refHigh: number | null; flag: string }[] }[];
}

const ascii = (s: string) => s.replace(/µ/g, 'u').replace(/³/g, '3').replace(/–/g, '-').replace(/[^\x20-\x7E]/g, '?');
const when = (d: Date | null) => (d ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(d) : '-');
const range = (lo: number | null, hi: number | null) => (lo != null && hi != null ? `${lo} - ${hi}` : lo != null ? `> ${lo}` : hi != null ? `< ${hi}` : '');
const FLAG: Record<string, string> = { NORMAL: '', LOW: 'L', HIGH: 'H', CRITICAL_LOW: 'L !!', CRITICAL_HIGH: 'H !!', ABNORMAL: 'Abnormal' };

/** The lab report (A4, paginated), with a QR code to verify it online. */
export async function reportPdf(r: ReportInput): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${r.orderNo} v${r.version} · ${r.hospital}`);
  pdf.setProducer('MediCare');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const qr = await pdf.embedPng(await toBuffer({ bcid: 'qrcode', text: r.verifyUrl, scale: 3 }));
  const ink = rgb(0.07, 0.09, 0.15);
  const muted = rgb(0.36, 0.39, 0.45);
  const brand = rgb(0.06, 0.46, 0.43);
  const red = rgb(0.7, 0.14, 0.09);
  let page!: PDFPage;
  let y = 0;
  const text = (s: string, x: number, size = 9, f: PDFFont = font, color = ink) => page.drawText(ascii(s), { x, y, size, font: f, color });

  const header = () => {
    page = pdf.addPage([595, 842]);
    y = 800;
    text(r.hospital, 40, 17, bold, brand);
    page.drawText('LABORATORY REPORT', { x: 555 - bold.widthOfTextAtSize('LABORATORY REPORT', 11), y, size: 11, font: bold, color: ink });
    y -= 15; text(r.branch, 40, 9, font, muted);
    y -= 10; page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 1, color: brand });
    y -= 16;
    text(`${r.patient.name}`, 40, 11, bold); text(`Order ${r.orderNo}${r.version > 1 ? `  (version ${r.version})` : ''}`, 330, 9, bold);
    y -= 13;
    text(`MRN ${r.patient.mrn} · ${r.patient.age ?? '?'} y${r.patient.sex ? ` / ${r.patient.sex[0]}` : ''}${r.referredBy ? ` · Referred by ${r.referredBy}` : ''}`, 40, 9, font, muted);
    text(`Collected ${when(r.collectedAt)}`, 330, 9, font, muted);
    y -= 12; text(`Reported ${when(r.reportedAt)}`, 330, 9, font, muted);
    if (r.amendment) {
      y -= 18;
      page.drawRectangle({ x: 40, y: y - 5, width: 515, height: 18, color: rgb(0.99, 0.93, 0.92) });
      text(`AMENDED REPORT - replaces version ${r.amendment.replaces}. Reason: ${r.amendment.reason}`.slice(0, 110), 46, 9, bold, red);
    }
    y -= 22;
    page.drawRectangle({ x: 40, y: y - 5, width: 515, height: 18, color: rgb(0.95, 0.96, 0.97) });
    for (const [label, x] of [['Test / parameter', 46], ['Result', 250], ['Unit', 330], ['Reference range', 400], ['Flag', 505]] as const) text(label, x, 8.5, bold, muted);
    y -= 20;
  };
  const ensure = (h: number) => { if (y - h < 130) header(); };

  header();
  for (const t of r.tests) {
    ensure(16 + t.results.length * 14);
    text(t.name, 46, 10, bold);
    y -= 14;
    for (const x of t.results) {
      const abnormal = x.flag !== 'NORMAL';
      text(x.parameter === 'Result' ? '' : x.parameter, 56, 9);
      text(x.value, 250, 9, abnormal ? bold : font, abnormal ? red : ink);
      text(x.unit ?? '', 330, 9, font, muted);
      text(range(x.refLow, x.refHigh), 400, 9, font, muted);
      text(FLAG[x.flag] ?? x.flag, 505, 9, bold, abnormal ? red : ink);
      y -= 14;
    }
    y -= 6;
  }
  // signature block + QR on the last page
  y = Math.min(y, 210);
  page.drawLine({ start: { x: 40, y: 120 }, end: { x: 555, y: 120 }, thickness: 0.5, color: muted });
  y = 100; text(`Verified by ${r.verifiedBy}`, 40, 10, bold);
  y = 86; text(`Electronically verified on ${when(r.reportedAt)}. H/L = above/below the reference range; !! = critical value.`, 40, 8, font, muted);
  y = 74; text('Reference ranges are for adults; interpret with your doctor.', 40, 8, font, muted);
  page.drawImage(qr, { x: 480, y: 40, width: 72, height: 72 });
  y = 30; text(`Verify: ${r.verifyCode}`, 470, 8, font, muted);
  return Buffer.from(await pdf.save());
}

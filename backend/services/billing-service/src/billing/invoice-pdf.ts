import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { InvoiceDto } from './billing.service.js';

const inr = (n: number) => `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: string | Date | null) => (d ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(d)) : '');

/** A one-page invoice/receipt (standard fonts: amounts in "Rs." since the rupee sign is not in WinAnsi). */
export async function invoicePdf(hospital: string, inv: InvoiceDto & { payments: { channel: string; method: string | null; amount: number; status: string; capturedAt: string | null; reference: string | null }[]; refunds: { amount: number; status: string; reason: string; processedAt: string | null }[] }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${inv.invoiceNo} · ${hospital}`);
  pdf.setProducer('MediCare');
  const page = pdf.addPage([595, 842]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.07, 0.09, 0.15);
  const muted = rgb(0.36, 0.39, 0.45);
  let y = 790;
  const text = (s: string, x: number, size = 10, f = font, color = ink) => page.drawText(s.replace(/[^\x20-\x7E]/g, '-'), { x, y, size, font: f, color });
  const right = (s: string, xr: number, size = 10, f = font) => page.drawText(s, { x: xr - f.widthOfTextAtSize(s, size), y, size, font: f, color: ink });

  text(hospital, 50, 18, bold);
  right(inv.status === 'PAID' ? 'RECEIPT' : 'INVOICE', 545, 16, bold);
  y -= 22; text(inv.branch.name, 50, 10, font, muted); right(inv.invoiceNo, 545, 11, bold);
  y -= 16; right(`Issued ${day(inv.issuedAt)}`, 545, 10);
  y -= 40; text('Billed to', 50, 9, bold, muted);
  y -= 16; text(inv.patient.name, 50, 12, bold);
  y -= 15; text(`MRN ${inv.patient.mrn}`, 50, 10, font, muted);

  y -= 40;
  page.drawRectangle({ x: 50, y: y - 6, width: 495, height: 22, color: rgb(0.95, 0.96, 0.97) });
  text('Description', 58, 10, bold); right('Amount', 537, 10, bold);
  y -= 26; text(inv.description.slice(0, 85), 58); right(inv.subtotal ? inr(inv.subtotal) : '', 537);
  if (inv.discount) { y -= 18; text('Discount', 58); right(`- ${inr(inv.discount)}`, 537); }
  if (inv.tax) { y -= 18; text('Tax', 58); right(inr(inv.tax), 537); }
  y -= 12; page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.6, color: muted });
  y -= 20; text('Total', 58, 11, bold); right(inr(inv.total), 537, 11, bold);

  y -= 40; text('Payments', 50, 9, bold, muted);
  const paid = inv.payments.filter((p) => p.status === 'CAPTURED');
  if (!paid.length) { y -= 16; text(inv.status === 'VOID' ? `Void${inv.voidReason ? ` (${inv.voidReason.toLowerCase().replaceAll('_', ' ')})` : ''}` : 'Not paid yet', 58); }
  for (const p of paid) {
    y -= 16;
    text(`${day(p.capturedAt)}  ${p.channel === 'ONLINE' ? 'Online' : 'At the counter'}${p.method ? `, ${p.method.toUpperCase()}` : ''}${p.reference ? ` (ref ${p.reference})` : ''}`, 58);
    right(inr(p.amount), 537);
  }
  const refunds = inv.refunds.filter((r) => r.status !== 'FAILED');
  if (refunds.length) {
    y -= 26; text('Refunds', 50, 9, bold, muted);
    for (const r of refunds) {
      y -= 16;
      text(`${day(r.processedAt) || 'In progress'}  ${r.reason.slice(0, 60)}`, 58);
      right(`- ${inr(r.amount)}`, 537);
    }
  }
  y -= 30; text(`Balance paid: ${inr(inv.amountPaid - inv.amountRefunded)}`, 50, 11, bold);
  y = 60; text('Computer-generated document; no signature required.', 50, 8, font, muted);
  return Buffer.from(await pdf.save());
}

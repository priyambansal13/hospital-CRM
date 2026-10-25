/** File types patients and doctors may upload, recognised by their first bytes (never by name or declared type). */
export const ALLOWED = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPEG image',
  'image/png': 'PNG image',
  'application/dicom': 'DICOM image',
} as const;
export type AllowedMime = keyof typeof ALLOWED;
export const MAX_BYTES = Number(process.env.DOCUMENT_MAX_BYTES ?? 20 * 1024 * 1024);

export function detectMime(b: Buffer): AllowedMime | null {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 132 && b.subarray(128, 132).toString('latin1') === 'DICM') return 'application/dicom';
  return null;
}

export const extensionFor = (m: AllowedMime) => ({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'application/dicom': 'dcm' })[m];

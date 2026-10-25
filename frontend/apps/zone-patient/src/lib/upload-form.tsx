'use client';
/**
 * Upload a report: the file goes from the browser straight to the hospital's storage (a 5-minute presigned PUT);
 * the server only hands out the URL and records the upload. The page refreshes while the virus scan runs.
 */
import { useRouter } from 'next/navigation.js';
import { useState } from 'react';
import type { registerUpload, requestUpload } from './health-actions';

const MIME_BY_EXT: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', dcm: 'application/dicom' };

export function UploadForm({ patientId, request, register }: { patientId: string; request: typeof requestUpload; register: typeof registerUpload }) {
  const router = useRouter();
  const [state, setState] = useState<{ busy: boolean; error?: string; ok?: string }>({ busy: false });
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = f.get('file') as File | null;
    if (!file || !file.size) return setState({ busy: false, error: 'Choose a file' });
    const type = file.type || MIME_BY_EXT[file.name.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream';
    setState({ busy: true });
    const t = await request(patientId, { name: file.name, type, size: file.size });
    if ('error' in t && t.error) return setState({ busy: false, error: t.error });
    const ticket = t as { uploadId: string; url: string; headers: Record<string, string> };
    const put = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: file }).catch(() => null);
    if (!put?.ok) return setState({ busy: false, error: 'The upload did not go through. Please try again.' });
    const r = await register(patientId, { uploadId: ticket.uploadId, title: String(f.get('title') || file.name.replace(/\.[^.]+$/, '')), type: String(f.get('type')), issuedOn: String(f.get('issuedOn') || '') || null });
    if ('error' in r) return setState({ busy: false, error: r.error });
    form.reset();
    setState({ busy: false, ok: 'Uploaded. We are checking the file; it appears in your record in a few seconds.' });
    router.refresh();
  };
  return (
    <form onSubmit={submit} className="mc-form" aria-label="Upload a report">
      <label className="mc-field"><span>File (PDF, JPEG, PNG or DICOM, up to 20 MB)</span><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.dcm,application/pdf,image/jpeg,image/png,application/dicom" required /></label>
      <label className="mc-field"><span>Title</span><input name="title" placeholder="e.g. Blood test, City Lab" maxLength={200} /></label>
      <label className="mc-field"><span>Type</span>
        <select name="type" defaultValue="LAB_REPORT">
          <option value="LAB_REPORT">Lab report</option><option value="IMAGING">Scan / X-ray</option><option value="DISCHARGE">Discharge summary</option>
          <option value="PRESCRIPTION">Prescription</option><option value="EXTERNAL">Other medical document</option>
        </select>
      </label>
      <label className="mc-field"><span>Date on the document</span><input type="date" name="issuedOn" /></label>
      <button type="submit" className="mc-btn mc-btn-primary" disabled={state.busy}>{state.busy ? 'Uploading…' : 'Upload'}</button>
      {state.error ? <p role="alert" className="mc-alert mc-alert-error mc-field-wide">{state.error}</p> : null}
      {state.ok ? <p role="status" className="mc-alert mc-alert-success mc-field-wide">{state.ok}</p> : null}
    </form>
  );
}

import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectMime } from './magic.js';
import { ClamdScanner, EicarOnlyScanner } from './scanner.js';

const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'latin1');

/** A fake clamd that speaks INSTREAM: reassembles the chunks and answers like clamd does. */
let server: Server;
let port = 0;
let received = Buffer.alloc(0);
beforeAll(async () => {
  server = createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!buf.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) return;
      let off = 10;
      const parts: Buffer[] = [];
      while (off + 4 <= buf.length) {
        const len = buf.readUInt32BE(off);
        if (len === 0) {
          received = Buffer.concat(parts);
          s.end(received.includes(EICAR) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (off + 4 + len > buf.length) return;
        parts.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

describe('clamd INSTREAM adapter', () => {
  it('streams the file in chunks and reads a clean answer', async () => {
    const big = Buffer.alloc(200_000, 7); // > 3 chunks
    const r = await new ClamdScanner('127.0.0.1', port).scan(big);
    expect(r).toEqual({ clean: true, signature: null, engine: 'clamav' });
    expect(received.equals(big)).toBe(true);
  });
  it('reports the signature when infected', async () => {
    const r = await new ClamdScanner('127.0.0.1', port).scan(Buffer.concat([Buffer.from('%PDF-1.4\n'), EICAR]));
    expect(r).toMatchObject({ clean: false, signature: 'Eicar-Test-Signature' });
  });
  it('fails (never "clean") when clamd is unreachable', async () => {
    await expect(new ClamdScanner('127.0.0.1', 1, 2000).scan(Buffer.from('x'))).rejects.toThrow();
  });
});

describe('dev scanner and type detection', () => {
  it('flags EICAR, passes ordinary files', async () => {
    expect((await new EicarOnlyScanner().scan(EICAR)).clean).toBe(false);
    expect((await new EicarOnlyScanner().scan(Buffer.from('%PDF-1.7 hello'))).clean).toBe(true);
  });
  it('recognises files by their first bytes', () => {
    expect(detectMime(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(detectMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(detectMime(Buffer.concat([Buffer.alloc(128), Buffer.from('DICM')]))).toBe('application/dicom');
    expect(detectMime(Buffer.from('MZ\x90\x00'))).toBeNull(); // a Windows executable named report.pdf
    expect(detectMime(Buffer.from('<html><script>'))).toBeNull();
  });
});

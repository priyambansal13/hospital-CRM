import { createConnection } from 'node:net';

export interface ScanResult { clean: boolean; signature: string | null; engine: string }
export interface VirusScanner { readonly name: string; scan(data: Buffer): Promise<ScanResult> }
export const VIRUS_SCANNER = Symbol('VIRUS_SCANNER');

/**
 * ClamAV over clamd's INSTREAM protocol: "zINSTREAM\0", then chunks of [4-byte big-endian length][bytes], then a
 * zero-length chunk; clamd answers "stream: OK" or "stream: <signature> FOUND" (NUL-terminated).
 */
export class ClamdScanner implements VirusScanner {
  readonly name = 'clamav';
  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs = 30_000) {}

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const sock = createConnection({ host: this.host, port: this.port });
      let reply = '';
      const done = (fn: () => void) => { sock.destroy(); fn(); };
      sock.setTimeout(this.timeoutMs, () => done(() => reject(new Error('clamd timed out'))));
      sock.on('error', (e) => done(() => reject(e)));
      sock.on('data', (d) => {
        reply += d.toString('utf8');
        if (!reply.includes('\0')) return;
        const line = reply.split('\0')[0].trim();
        done(() => {
          if (line.endsWith(': OK')) resolve({ clean: true, signature: null, engine: this.name });
          else if (line.endsWith(' FOUND')) resolve({ clean: false, signature: line.replace(/^.*?: /, '').replace(/ FOUND$/, ''), engine: this.name });
          else reject(new Error(`clamd: ${line}`));
        });
      });
      sock.on('connect', () => {
        sock.write('zINSTREAM\0');
        for (let i = 0; i < data.length; i += 64 * 1024) {
          const chunk = data.subarray(i, i + 64 * 1024);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length);
          sock.write(len);
          sock.write(chunk);
        }
        sock.write(Buffer.alloc(4));
      });
    });
  }
}

/**
 * Dev-only stand-in (ClamAV needs ~1.3 GB of RAM): flags the industry-standard EICAR test file, which every real
 * scanner also flags, so the INFECTED path can be exercised locally. Refused outside dev.
 */
export class EicarOnlyScanner implements VirusScanner {
  readonly name = 'dev-eicar';
  private static readonly EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  async scan(data: Buffer): Promise<ScanResult> {
    const found = data.includes(Buffer.from(EicarOnlyScanner.EICAR, 'latin1'));
    return { clean: !found, signature: found ? 'Eicar-Test-Signature' : null, engine: this.name };
  }
}

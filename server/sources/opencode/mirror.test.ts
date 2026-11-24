import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpencodeSource } from './source';

// H2: steady-state mirror refresh reads only the newest few messages.
describe('terminal mirror fetch size', () => {
  afterEach(() => vi.restoreAllMocks());
  it('first refresh reads 60, later refreshes read 4, a gap falls back to 60', async () => {
    const limits: number[] = [];
    let msgs = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, type: 'user', text: `p${i}`, time: { created: i } }));
    vi.stubGlobal('fetch', async (url: string) => {
      const m = /message\?limit=(\d+)/.exec(url);
      if (m) {
        const n = Number(m[1]);
        limits.push(n);
        return new Response(JSON.stringify({ data: [...msgs].reverse().slice(0, n) }));
      }
      return new Response('{}');
    });
    const src = new OpencodeSource({ accounts: {} as never, office: {} as never, home: mkdtempSync(join(tmpdir(), 'oc-')), env: { HABBLAUD_OPENCODE_MIRROR: mkdtempSync(join(tmpdir(), 'ocm-')) } });
    const t = { session: { id: 'ses_m' }, inOffice: true, status: 'working' } as never;
    const svc = { url: 'http://x', password: 'p' };
    const mirror = (src as unknown as { mirror: (s: unknown, t: unknown) => Promise<void> }).mirror.bind(src);
    await mirror(svc, t);
    msgs = [...msgs, { id: 'm10', type: 'user', text: 'p10', time: { created: 10 } }];
    await mirror(svc, t);
    msgs = [...msgs, ...Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, type: 'user', text: 'x', time: { created: 20 + i } }))];
    await mirror(svc, t);
    expect(limits).toEqual([60, 4, 4, 60]);
  });
});

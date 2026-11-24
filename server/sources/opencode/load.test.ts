import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpencodeSource } from './source';

// M4: with the bridge's pending list, the source no longer fetches /permission itself.
describe('request load', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses pendingOf instead of GET /permission and still reports waiting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-'));
    const file = join(dir, 'service.json');
    writeFileSync(file, JSON.stringify({ url: 'http://x', password: 'p' }));
    const paths: string[] = [];
    const now = Date.now();
    vi.stubGlobal('fetch', async (url: string) => {
      const path = url.replace('http://x', '');
      paths.push(path.split('?')[0]);
      if (path === '/api/session/active') return new Response(JSON.stringify({ data: { ses_w: { type: 'running' } } }));
      if (path.startsWith('/api/session?')) return new Response(JSON.stringify({ data: [{ id: 'ses_w', location: { directory: '/w' }, time: { created: now, updated: now } }] }));
      return new Response(JSON.stringify({ data: [] }));
    });
    const statuses: string[] = [];
    const office = { addMain() {}, has: () => true, setStatus: (_id: string, st: string) => statuses.push(st), addActivity() {}, applyTranscript() {} };
    const src = new OpencodeSource({ accounts: {} as never, office: office as never, home: dir, env: { OPENCODE_SERVICE_FILE: file, HABBLAUD_OPENCODE_MIRROR: join(dir, 'm') } });
    src.pendingOf = (sid) => (sid === 'ses_w' ? 'bash go test' : undefined);
    await (src as unknown as { poll: (b: boolean) => Promise<void> }).poll(true);
    expect(paths.some((p) => p.endsWith('/permission'))).toBe(false);
    expect(statuses).toContain('waiting');
  });
});

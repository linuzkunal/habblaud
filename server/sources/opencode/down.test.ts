import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpencodeSource } from './source';

// H3: when the service stops answering, infiniacode characters leave instead of freezing.
describe('service down', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('closes in-office agents after 3 failed polls, keeps them before that', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-'));
    const file = join(dir, 'service.json');
    writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:1', password: 'p' }));
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const closed: string[] = [];
    const office = { closeMain: (id: string) => closed.push(id), completeSub: (id: string) => closed.push(id) };
    const src = new OpencodeSource({ accounts: {} as never, office: office as never, home: dir, env: { OPENCODE_SERVICE_FILE: file } });
    const internals = src as unknown as { tracked: Map<string, unknown>; poll: (b: boolean) => Promise<void> };
    internals.tracked.set('ses_a', { session: { id: 'ses_a' }, inOffice: true, status: 'working' });
    await internals.poll(false);
    await internals.poll(false);
    expect(closed).toEqual([]);
    await internals.poll(false);
    expect(closed).toEqual(['ses_a']);
    expect(internals.tracked.size).toBe(0);
  });
});

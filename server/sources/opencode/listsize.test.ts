import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpencodeSource } from './source';

// L6: a full page of recently-updated sessions triggers a bigger read.
describe('session list size', () => {
  afterEach(() => vi.unstubAllGlobals());
  async function run(updatedAgoMs: number): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), 'oc-'));
    const file = join(dir, 'service.json');
    writeFileSync(file, JSON.stringify({ url: 'http://x', password: 'p' }));
    const lists: string[] = [];
    const now = Date.now();
    vi.stubGlobal('fetch', async (url: string) => {
      const m = /\/api\/session\?limit=(\d+)/.exec(url);
      if (m) {
        lists.push(m[1]);
        return new Response(JSON.stringify({ data: Array.from({ length: Number(m[1]) === 60 ? 60 : 61 }, (_, i) => ({ id: `ses_${i}`, parentID: 'ses_x', time: { updated: now - updatedAgoMs } })) }));
      }
      return new Response(JSON.stringify({ data: {} }));
    });
    const src = new OpencodeSource({ accounts: {} as never, office: {} as never, home: dir, env: { OPENCODE_SERVICE_FILE: file } });
    await (src as unknown as { poll: (b: boolean) => Promise<void> }).poll(true);
    return lists;
  }
  it('reads 300 when all 60 were updated recently', async () => expect(await run(60_000)).toEqual(['60', '300']));
  it('keeps 60 when the oldest of the page is old', async () => expect(await run(3 * 3600_000)).toEqual(['60']));
});

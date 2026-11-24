import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpencodeHistory } from './history';

describe('L4: infiniacode history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'och-'));
  writeFileSync(join(dir, 'ses_abc.jsonl'), JSON.stringify({ id: 'm1', type: 'user', text: 'Fix the login bug\nplease', time: { created: 5 } }) + '\n');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  const h = new OpencodeHistory({ dir, account: () => 'infiniacode', openAgentOf: () => undefined });
  it('lists mirror files as recent sessions with the first prompt as title', async () => {
    const l = await h.list();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ account: 'infiniacode', provider: 'opencode', sessionId: 'ses_abc', title: 'Fix the login bug', firstAt: 5, open: false });
  });
  it('resolves with the infiniacode parser; rejects bad ids and other accounts', () => {
    const r = h.resolve('infiniacode', 'ses_abc');
    expect('path' in r && r.createParser().push(JSON.stringify({ id: 'm', type: 'user', text: 'hi' }))[0]).toMatchObject({ kind: 'user', text: 'hi' });
    expect(h.resolve('infiniacode', '../etc/passwd')).toMatchObject({ status: 400 });
    expect(h.resolve('.claude', 'ses_abc')).toMatchObject({ status: 404 });
  });
});

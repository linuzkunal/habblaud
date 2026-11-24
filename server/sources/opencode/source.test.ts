import { describe, expect, it } from 'vitest';
import { describeOpencodeTool } from './source';

describe('describeOpencodeTool', () => {
  it('maps opencode tools onto the shared descriptions', () => {
    expect(describeOpencodeTool('read', { filePath: '/x/App.tsx' }).kind).toBe('read');
    expect(describeOpencodeTool('edit', { filePath: '/x/App.tsx' }).kind).toBe('edit');
    expect(describeOpencodeTool('grep', { pattern: 'warden' }).kind).toBe('search');
    expect(describeOpencodeTool('shell', { command: 'go test ./...' }).detail).toContain('go test');
  });
  it('names the tools a code-mode snippet calls', () => {
    const d = describeOpencodeTool('execute', { code: 'await tools["atlas-ping"].browser_read_tab({tab_id:1})' });
    expect(d.text).toContain('atlas-ping.browser_read_tab');
  });
  it('falls back for unknown tools', () => {
    expect(describeOpencodeTool('mystery', {}).text.length).toBeGreaterThan(0);
  });
});

import { maskDeep } from './source';
describe('M2: mirror lines are masked', () => {
  it('masks secrets in nested tool output, keeps ids', () => {
    const m = { id: 'msg_1', content: [{ type: 'tool', state: { content: [{ type: 'text', text: 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' }] } }] };
    const out = JSON.stringify(maskDeep(m));
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).toContain('msg_1');
  });
});

import { mkdtempSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneMirrors } from './source';
describe('M3: mirror pruning', () => {
  it('removes .jsonl files older than 7 days, keeps recent ones and other files', () => {
    const d = mkdtempSync(join(tmpdir(), 'ocm-'));
    for (const n of ['old.jsonl', 'new.jsonl', 'note.txt']) writeFileSync(join(d, n), 'x');
    const eightDaysAgo = (Date.now() - 8 * 86400_000) / 1000;
    utimesSync(join(d, 'old.jsonl'), eightDaysAgo, eightDaysAgo);
    utimesSync(join(d, 'note.txt'), eightDaysAgo, eightDaysAgo);
    expect(pruneMirrors(d)).toBe(1);
    expect(existsSync(join(d, 'old.jsonl'))).toBe(false);
    expect(existsSync(join(d, 'new.jsonl'))).toBe(true);
    expect(existsSync(join(d, 'note.txt'))).toBe(true);
  });
});

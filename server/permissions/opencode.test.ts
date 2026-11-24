import { describe, expect, it } from 'vitest';
import { answersToForm, askableFields, formToAsk, permissionToTool, type OcForm } from './opencode';

const form: OcForm = {
  id: 'frm_1', sessionID: 'ses_1', title: 'Questions', metadata: { kind: 'question' },
  fields: [
    { key: 'q0', type: 'multiselect', title: 'Fix scope', description: 'How do you want me to proceed?', options: [
      { value: 'fix1', label: 'Fix #1', description: 'csv' }, { value: 'fix2', label: 'Fix #2' }, { value: 'fix3', label: 'Fix #3' }] },
    { key: 'q1', type: 'boolean', title: 'Push', description: 'Open a PR afterwards?' },
  ],
};

describe('infiniacode asks bridge', () => {
  it('form → AskUserQuestion input', () => {
    const f = askableFields(form)!;
    const ask = formToAsk(f) as { questions: { question: string; multiSelect: boolean; options: { label: string }[] }[] };
    expect(ask.questions[0]).toMatchObject({ question: 'How do you want me to proceed?', multiSelect: true });
    expect(ask.questions[0].options.map((o) => o.label)).toEqual(['Fix #1', 'Fix #2', 'Fix #3']);
    expect(ask.questions[1].options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });
  it('office answers (by position) → form answer (by key)', () => {
    const f = askableFields(form)!;
    expect(answersToForm(f, [{ question: 0, options: [0, 2] }, { question: 1, options: [1] }])).toEqual({ q0: ['fix1', 'fix3'], q1: false });
  });
  it('free-text fields stay infiniacode-only', () => {
    expect(askableFields({ ...form, fields: [{ key: 'q', type: 'string', title: 'Why?' }] })).toBeUndefined();
  });
  it('permission → tool view', () => {
    expect(permissionToTool({ id: 'p', sessionID: 's', action: 'bash', resources: ['go', 'test', './...'] })).toEqual({ tool: 'Bash', input: { command: 'go test ./...' } });
    expect(permissionToTool({ id: 'p', sessionID: 's', action: 'edit', resources: ['/a/b.go'] }).input).toEqual({ file_path: '/a/b.go' });
  });
});

import { PermissionRegistry } from './registry';
describe('H1: no free-text "Other" answers for infiniacode', () => {
  it('the registry refuses an infiniacode answer carrying "Other" text, accepts options', () => {
    const agent = { id: 'ses_q', kind: 'main', provider: 'opencode', status: 'waiting', sessionId: 'ses_q' } as never;
    const office = { get: (id: string) => (id === 'ses_q' ? agent : undefined), list: () => [agent], markDirty() {}, addActivity() {}, noticePermission() {} };
    const reg = new PermissionRegistry({ office, viewers: () => 1 } as never);
    const r = reg.register({ provider: 'opencode', session_id: 'ses_q', tool_name: 'AskUserQuestion', tool_input: formToAsk(askableFields(form)!) });
    if (!('id' in r)) throw new Error('not registered: ' + JSON.stringify(r));
    expect(reg.decide(r.id, { behavior: 'answer', answers: [{ question: 0, other: 'something else' }, { question: 1, options: [0] }] })).toBe('invalid-answer');
    expect(reg.decide(r.id, { behavior: 'answer', answers: [{ question: 0, options: [1] }, { question: 1, options: [0] }] })).toBe('ok');
  });
});

import { OpencodeAsks } from './opencode';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
describe('M1: a released card is registered again', () => {
  it('unwatched → re-registered on the next poll; terminal → not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-'));
    const file = join(dir, 'service.json');
    writeFileSync(file, JSON.stringify({ url: 'http://x', password: 'p' }));
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/api/session/active')) return new Response(JSON.stringify({ data: { ses_q: {} } }));
      if (url.endsWith('/form')) return new Response(JSON.stringify({ data: [form] }));
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;
    let registers = 0;
    let reason: 'unwatched' | 'terminal' = 'unwatched';
    const registry = {
      register: () => ({ id: `p${++registers}`, expiresAt: 0 }),
      wait: () => ({ result: Promise.resolve({ status: 'released', reason }), cancel() {} }),
    };
    const asks = new OpencodeAsks({ registry: registry as never, serviceFile: file, fetchImpl });
    await asks.poll();
    await new Promise((r) => setTimeout(r, 0));
    await asks.poll();
    expect(registers).toBe(2); // released as unwatched → came back
    reason = 'terminal';
    await new Promise((r) => setTimeout(r, 0));
    await asks.poll();
    await new Promise((r) => setTimeout(r, 0));
    await asks.poll();
    expect(registers).toBe(3); // released by "answer in terminal" → stays released
  });
});

describe('M5: deny and interrupt', () => {
  it('rejects the permission, then interrupts the session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-'));
    const file = join(dir, 'service.json');
    writeFileSync(file, JSON.stringify({ url: 'http://x', password: 'p' }));
    const posts: { path: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const path = url.replace('http://x', '');
      if (init.method === 'POST') posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/api/session/active') return new Response(JSON.stringify({ data: { ses_p: {} } }));
      if (path.endsWith('/permission')) return new Response(JSON.stringify({ data: [{ id: 'per_1', sessionID: 'ses_p', action: 'bash', resources: ['rm -rf x'] }] }));
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;
    const registry = {
      register: () => ({ id: 'p1', expiresAt: 0 }),
      wait: () => ({ result: Promise.resolve({ status: 'decided', behavior: 'deny', message: 'no', interrupt: true }), cancel() {} }),
    };
    const asks = new OpencodeAsks({ registry: registry as never, serviceFile: file, fetchImpl });
    await asks.poll();
    await new Promise((r) => setTimeout(r, 10));
    expect(posts.map((p) => p.path)).toEqual(['/api/session/ses_p/permission/per_1/reply', '/api/session/ses_p/interrupt']);
    expect(posts[0].body).toEqual({ decision: 'reject', message: 'no' });
  });
});

describe('L7: no leftover retries', () => {
  it('forgets a skipped item once it vanishes from infiniacode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-'));
    const file = join(dir, 'service.json');
    writeFileSync(file, JSON.stringify({ url: 'http://x', password: 'p' }));
    let present = true;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/api/session/active')) return new Response(JSON.stringify({ data: { ses_q: {} } }));
      if (url.endsWith('/form')) return new Response(JSON.stringify({ data: present ? [form] : [] }));
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;
    const registry = { register: () => ({ skip: 'no-viewers' }), wait: () => undefined };
    const asks = new OpencodeAsks({ registry: registry as never, serviceFile: file, fetchImpl });
    await asks.poll();
    const internals = asks as unknown as { pendingRaw: Map<string, unknown> };
    expect(internals.pendingRaw.size).toBe(1);
    present = false;
    await asks.poll();
    expect(internals.pendingRaw.size).toBe(0);
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOpencodeControl } from './opencode';

function svc(): string {
  const f = join(mkdtempSync(join(tmpdir(), 'oc-')), 'service.json');
  writeFileSync(f, JSON.stringify({ url: 'http://127.0.0.1:1', password: 'pw' }));
  return f;
}
type Call = { method: string; url: string; body?: unknown };
function fakeFetch(calls: Call[], reply: (c: Call) => [number, unknown]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const c = { method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const [status, json] = reply(c);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
}

describe('opencode control', () => {
  it('start: creates the session in the folder, then queues the instruction', async () => {
    const calls: Call[] = [];
    const ctl = createOpencodeControl(svc(), { isDir: () => true, fetchImpl: fakeFetch(calls, (c) => (c.url.endsWith('/api/session') ? [200, { data: { id: 'ses_new1' } }] : [200, { data: {} }])) });
    expect(await ctl.start({ folder: '/w/p', prompt: 'fix the login bug' })).toEqual({ ok: true, sessionId: 'ses_new1' });
    expect(calls.map((c) => `${c.method} ${c.url.replace('http://127.0.0.1:1', '')}`)).toEqual(['POST /api/session', 'POST /api/session/ses_new1/prompt']);
    expect(calls[0].body).toEqual({ title: 'fix the login bug', location: { directory: '/w/p' } });
    expect(calls[1].body).toEqual({ text: 'fix the login bug', delivery: 'queue' });
  });
  it('start with attachments sends them as files and lists the paths in the text', async () => {
    const calls: Call[] = [];
    const ctl = createOpencodeControl(svc(), { isDir: () => true, fetchImpl: fakeFetch(calls, (c) => (c.url.endsWith('/api/session') ? [200, { data: { id: 'ses_f1' } }] : [200, { data: {} }])) });
    expect(await ctl.start({ folder: '/w/p', prompt: 'look at this', files: ['/etc/passwd'] }, ['/h/.habblaud/attachments/x/shot 1.png'])).toMatchObject({ ok: true });
    const body = calls[1].body as { text: string; files: { uri: string; name: string }[] };
    expect(body.files).toEqual([{ uri: 'file:///h/.habblaud/attachments/x/shot%201.png', name: 'shot 1.png' }]);
    expect(body.text).toMatch(/^look at this\n\n.*\n- \/h\/\.habblaud\/attachments\/x\/shot 1\.png$/);
    expect(JSON.stringify(body)).not.toContain('/etc/passwd'); // a `files` field in the request body is ignored
  });
  it('start with only attachments still sends a prompt', async () => {
    const calls: Call[] = [];
    const ctl = createOpencodeControl(svc(), { isDir: () => true, fetchImpl: fakeFetch(calls, () => [200, { data: { id: 'ses_f2' } }]) });
    await ctl.start({ folder: '/w/p', prompt: '' }, ['/a/b.txt']);
    expect(calls).toHaveLength(2);
  });
  it('rename: PATCHes the trimmed title; rejects empty, too long and bad ids', async () => {
    const calls: Call[] = [];
    const ctl = createOpencodeControl(svc(), { fetchImpl: fakeFetch(calls, () => [200, { data: {} }]) });
    expect(await ctl.rename('ses_r1', { title: '  Sprint 11\n cleanup ' })).toEqual({ ok: true, title: 'Sprint 11 cleanup' });
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { title: 'Sprint 11 cleanup' } });
    expect(calls[0].url).toMatch(/\/api\/session\/ses_r1$/);
    expect(await ctl.rename('ses_r1', { title: '  ' })).toMatchObject({ ok: false, status: 400 });
    expect(await ctl.rename('ses_r1', { title: 'x'.repeat(201) })).toMatchObject({ ok: false, status: 400 });
    expect(await ctl.rename('../x', { title: 'a' })).toMatchObject({ ok: false, status: 400 });
    expect(calls).toHaveLength(1);
  });
  it('start without an instruction only creates the session', async () => {
    const calls: Call[] = [];
    const ctl = createOpencodeControl(svc(), { isDir: () => true, fetchImpl: fakeFetch(calls, () => [200, { data: { id: 'ses_x' } }]) });
    expect(await ctl.start({ folder: '/w/p', prompt: '' })).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
  });
  it('start rejects relative or missing folders', async () => {
    const ctl = createOpencodeControl(svc(), { isDir: () => false, fetchImpl: fakeFetch([], () => [200, {}]) });
    expect(await ctl.start({ folder: 'rel/path' })).toMatchObject({ ok: false, status: 400 });
    expect(await ctl.start({ folder: '/nope' })).toMatchObject({ ok: false, status: 400 });
  });
  it('stop: interrupts, then archives (never deletes)', async () => {
    const calls: Call[] = [];
    const ctl = createOpencodeControl(svc(), { fetchImpl: fakeFetch(calls, () => [200, { data: {} }]) });
    expect(await ctl.stop('ses_abc')).toEqual({ ok: true });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'PATCH']);
    expect(calls[2].body).toEqual({ archived: true });
    expect(await ctl.stop('../x')).toMatchObject({ ok: false, status: 400 });
  });
});

describe('L1: off-board stops subagents too', () => {
  it('interrupts each child session before archiving the parent', async () => {
    const calls: Call[] = [];
    const ctl = createOpencodeControl(svc(), {
      fetchImpl: fakeFetch(calls, (c) => (c.url.includes('parentID=ses_p') ? [200, { data: [{ id: 'ses_k1' }, { id: 'ses_k2' }] }] : [200, { data: {} }])),
    });
    expect(await ctl.stop('ses_p')).toEqual({ ok: true });
    expect(calls.map((c) => `${c.method} ${c.url.replace('http://127.0.0.1:1', '').split('?')[0]}`)).toEqual([
      'POST /api/session/ses_p/interrupt', 'GET /api/session', 'POST /api/session/ses_k1/interrupt', 'POST /api/session/ses_k2/interrupt', 'PATCH /api/session/ses_p',
    ]);
  });
});

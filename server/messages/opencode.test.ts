import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOpencodeSender } from './opencode';

function svcFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-'));
  const f = join(dir, 'service.json');
  writeFileSync(f, JSON.stringify({ url: 'http://127.0.0.1:1/', password: 'pw' }));
  return f;
}

describe('createOpencodeSender', () => {
  it('posts the text to the session prompt endpoint with Basic auth, queued', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response('{"data":{}}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await createOpencodeSender(svcFile(), { fetchImpl: fake })('ses_abc123', 'run the tests');
    expect(r).toEqual({ ok: true });
    expect(seen!.url).toBe('http://127.0.0.1:1/api/session/ses_abc123/prompt');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Basic ' + Buffer.from('opencode:pw').toString('base64'));
    expect(JSON.parse(String(seen!.init.body))).toEqual({ text: 'run the tests', delivery: 'queue' });
  });
  it('reports HTTP errors and bad ids without throwing', async () => {
    const fake = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const send = createOpencodeSender(svcFile(), { fetchImpl: fake });
    expect(await send('ses_abc', 'x')).toMatchObject({ ok: false });
    expect(await send('../etc', 'x')).toEqual({ ok: false, error: 'invalid infiniacode session id' });
  });
  it('service not running', async () => {
    expect(await createOpencodeSender('/nonexistent/service.json')('ses_a', 'x')).toMatchObject({ ok: false });
  });
});

// Messages from the office to infiniacode / opencode v2 sessions. No plugin needed: the background service has an
// API for it — POST /api/session/<id>/prompt {text, delivery: "queue"} "durably admits one session input and
// schedules agent-loop execution", i.e. the text is queued like a prompt typed in that session and runs when the
// session is free. The service's URL and password are re-read from service.json on every send (they change when
// the service restarts). Never rejects: failures come back as {ok: false, error}.
import { readFileSync } from 'node:fs';

export const SEND_TIMEOUT_MS = 10_000;
/** opencode session ids look like "ses_" + base62. */
export const SESSION_ID = /^ses_[A-Za-z0-9]+$/;
const ERROR_MAX = 300;

export type OpencodeSendResult = { ok: true } | { ok: false; error: string };
export type OpencodeSender = (sessionId: string, text: string) => Promise<OpencodeSendResult>;

export function createOpencodeSender(serviceFile: string, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): OpencodeSender {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? SEND_TIMEOUT_MS;
  return async (sessionId, text) => {
    if (!SESSION_ID.test(sessionId)) return { ok: false, error: 'invalid infiniacode session id' };
    let svc: { url?: string; password?: string };
    try {
      svc = JSON.parse(readFileSync(serviceFile, 'utf8')) as { url?: string; password?: string };
    } catch {
      return { ok: false, error: 'infiniacode service is not running (no service.json)' };
    }
    if (!svc.url || !svc.password) return { ok: false, error: 'infiniacode service.json has no url/password' };
    try {
      const res = await doFetch(`${svc.url.replace(/\/$/, '')}/api/session/${sessionId}/prompt`, {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + Buffer.from(`opencode:${svc.password}`).toString('base64'),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ text, delivery: 'queue' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return { ok: true };
      let detail = '';
      try {
        detail = (await res.text()).slice(0, ERROR_MAX);
      } catch {
        /* no body */
      }
      return { ok: false, error: `infiniacode refused the message (HTTP ${res.status})${detail ? `: ${detail}` : ''}`.slice(0, ERROR_MAX) };
    } catch (err) {
      const name = (err as Error)?.name;
      return { ok: false, error: name === 'TimeoutError' ? `infiniacode did not answer in ${Math.round(timeoutMs / 1000)} s` : 'could not reach the infiniacode service' };
    }
  };
}

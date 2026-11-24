// Start ("on-board") and stop ("off-board") infiniacode / opencode v2 sessions from the office, through the
// background service API — no terminal, no CLI:
//   start: POST /api/session {title, location: {directory: <folder>}} → POST /api/session/<id>/prompt {text, delivery: "queue"}
//          The session runs inside the service (open it in infiniacode to watch/take over); its character walks in
//          on the next poll of sources/opencode.
//   stop:  POST /api/session/<id>/interrupt (stops the current turn), then PATCH {archived: true} — archived, not
//          deleted: it can still be restored in infiniacode. The character leaves when it goes idle/archived.
// The service URL/password are re-read from service.json on every call. Never throws: errors come back as values.
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const PROMPT_MAX = 8_000;
export const FOLDER_MAX = 1_024;
const SESSION_ID = /^ses_[A-Za-z0-9]+$/;
const TIMEOUT_MS = 10_000;

export type ControlResult<T = object> = ({ ok: true } & T) | { ok: false; status: number; error: string };

export interface OpencodeControl {
  /** macOS native "Choose Folder" dialog on this computer → absolute path (cancelled = ok:false, status 499). */
  pickFolder(): Promise<ControlResult<{ path: string }>>;
  start(raw: unknown): Promise<ControlResult<{ sessionId: string }>>;
  stop(sessionId: string): Promise<ControlResult>;
}

export function createOpencodeControl(serviceFile: string, opts: { fetchImpl?: typeof fetch; isDir?: (p: string) => boolean } = {}): OpencodeControl {
  const doFetch = opts.fetchImpl ?? fetch;
  const isDir =
    opts.isDir ??
    ((p: string) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });

  async function call(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json?: unknown; text?: string }> {
    let svc: { url?: string; password?: string };
    try {
      svc = JSON.parse(readFileSync(serviceFile, 'utf8')) as { url?: string; password?: string };
    } catch {
      return { ok: false, status: 503, text: 'infiniacode service is not running (no service.json)' };
    }
    if (!svc.url || !svc.password) return { ok: false, status: 503, text: 'infiniacode service.json has no url/password' };
    try {
      const res = await doFetch(svc.url.replace(/\/$/, '') + path, {
        method,
        headers: {
          authorization: 'Basic ' + Buffer.from(`opencode:${svc.password}`).toString('base64'),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text().catch(() => '');
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { ok: res.ok, status: res.status, json, text: text.slice(0, 300) };
    } catch (err) {
      return { ok: false, status: 502, text: (err as Error)?.name === 'TimeoutError' ? 'infiniacode did not answer in time' : 'could not reach the infiniacode service' };
    }
  }

  return {
    pickFolder() {
      if (process.platform !== 'darwin') return Promise.resolve({ ok: false, status: 501, error: 'the folder picker is macOS only' });
      const script = 'POSIX path of (choose folder with prompt "Choose the project folder for the new employee")';
      return new Promise((done) => {
        execFile('/usr/bin/osascript', ['-e', script], { timeout: 180_000, encoding: 'utf8' }, (err, stdout, stderr) => {
          if (err) {
            const cancelled = /-128|User canceled/i.test(String(stderr)) || /-128/.test(String(err.message));
            return done({ ok: false, status: cancelled ? 499 : 500, error: cancelled ? 'cancelled' : 'could not open the folder picker' });
          }
          const path = stdout.trim().replace(/\/$/, '') || '/';
          done(isAbsolute(path) && isDir(path) ? { ok: true, path } : { ok: false, status: 500, error: 'the picker returned no folder' });
        });
      });
    },

    async start(raw) {
      const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const folder = typeof r.folder === 'string' ? r.folder.trim() : '';
      const prompt = typeof r.prompt === 'string' ? r.prompt.replace(/\s+$/, '') : '';
      if (!folder || folder.length > FOLDER_MAX || !isAbsolute(folder)) return { ok: false, status: 400, error: 'choose a project folder (absolute path)' };
      if (!isDir(folder)) return { ok: false, status: 400, error: `folder not found: ${folder}` };
      if (prompt.length > PROMPT_MAX) return { ok: false, status: 400, error: `the instruction is longer than ${PROMPT_MAX} characters` };
      const title = prompt ? prompt.split('\n')[0].slice(0, 60) : `New session in ${folder.split('/').pop()}`;
      const created = await call('POST', '/api/session', { title, location: { directory: folder } });
      const id = (created.json as { data?: { id?: string } } | undefined)?.data?.id;
      if (!created.ok || !id || !SESSION_ID.test(id)) return { ok: false, status: created.ok ? 502 : created.status, error: `infiniacode could not create the session: ${created.text ?? ''}`.trim() };
      if (prompt) {
        const sent = await call('POST', `/api/session/${id}/prompt`, { text: prompt, delivery: 'queue' });
        if (!sent.ok) return { ok: false, status: sent.status, error: `session ${id} created, but the instruction was not accepted: ${sent.text ?? ''}`.trim() };
      }
      return { ok: true, sessionId: id };
    },

    async stop(sessionId) {
      if (!SESSION_ID.test(sessionId)) return { ok: false, status: 400, error: 'invalid infiniacode session id' };
      await call('POST', `/api/session/${sessionId}/interrupt`, {}); // idle sessions may refuse: archiving still applies
      // L1: its subagents (child sessions) stop too, otherwise they keep working after the off-board.
      const kids = (await call('GET', `/api/session?parentID=${encodeURIComponent(sessionId)}&limit=100`)).json as { data?: { id?: string }[] } | undefined;
      const list = Array.isArray(kids?.data) ? kids.data : []; // an odd reply must never break the off-board
      for (const k of list) if (k?.id && SESSION_ID.test(k.id)) await call('POST', `/api/session/${k.id}/interrupt`, {});
      const archived = await call('PATCH', `/api/session/${sessionId}`, { archived: true });
      if (!archived.ok) return { ok: false, status: archived.status, error: `infiniacode could not archive the session: ${archived.text ?? ''}`.trim() };
      return { ok: true };
    },
  };
}

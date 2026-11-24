// Answering infiniacode / opencode v2 questions and permission requests from the office.
//
// Claude Code reaches the PermissionRegistry through a hook that registers a request and long-polls for the answer.
// infiniacode has no hook, but its background service exposes the pending items, so this bridge plays the hook:
//   questions:   GET /api/session/<id>/form        → register as an AskUserQuestion (fields → questions/options)
//                POST …/form/<formID>/reply {answer: {<key>: value}}
//   permissions: GET /api/session/<id>/permission  → register as a tool approval (action → Claude tool name)
//                POST …/permission/<reqID>/reply {decision: once | reject, message?}
// Only running sessions are polled. An item that disappears from infiniacode (answered there) is released here by
// dropping the wait, so the card turns back into "answer in infiniacode". Never throws; failures go to the log.
import { readFileSync } from 'node:fs';
import type { PermissionAnswer } from '../../shared/types';
import { errMsg, log } from '../log';
import type { PermissionRegistry } from './registry';

const POLL_MS = 1500;
const WAIT_MS = 25_000;
const HOOK_TIMEOUT_MS = 30 * 60_000; // long: infiniacode itself waits until it's answered

type Rec = Record<string, unknown>;

export interface OcOption {
  value: string;
  label: string;
  description?: string;
}
export interface OcField {
  key: string;
  type: string;
  title?: string;
  description?: string;
  hidden?: boolean;
  when?: unknown[];
  maxItems?: number;
  options?: OcOption[];
}
export interface OcForm {
  id: string;
  sessionID: string;
  title?: string;
  metadata?: { kind?: string };
  fields: OcField[];
}
export interface OcPermission {
  id: string;
  sessionID: string;
  action?: string;
  resources?: string[];
  message?: string;
}

const TOOL: Record<string, string> = {
  bash: 'Bash', shell: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', patch: 'Edit', apply_patch: 'Edit',
  grep: 'Grep', glob: 'Glob', list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', task: 'Task',
};

/** The form's fields that become questions (multiselect / boolean, visible, unconditional), or undefined if the form
 *  has any field the office can't answer (free text, number, external link): then it stays an infiniacode-only form. */
export function askableFields(form: OcForm): OcField[] | undefined {
  const shown = form.fields.filter((f) => !f.hidden);
  if (!shown.length) return undefined;
  for (const f of shown) {
    if (f.when?.length) return undefined;
    if (f.type === 'multiselect' && f.options?.length) continue;
    if (f.type === 'boolean') continue;
    return undefined;
  }
  return shown;
}

/** Form → AskUserQuestion tool_input (Claude Code's shape, which the office cards already render). */
export function formToAsk(fields: OcField[]): Rec {
  return {
    questions: fields.map((f) => {
      const header = (f.title ?? f.key).slice(0, 12);
      const question = f.description || f.title || f.key;
      if (f.type === 'boolean') return { question, header, multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] };
      return {
        question,
        header,
        multiSelect: f.maxItems !== 1,
        options: (f.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
      };
    }),
  };
}

/** Office answers (by position) → infiniacode form answer (by field key). */
export function answersToForm(fields: OcField[], answers: PermissionAnswer[]): Record<string, string[] | boolean> {
  const out: Record<string, string[] | boolean> = {};
  for (const a of answers) {
    const f = fields[a.question];
    if (!f) continue;
    if (f.type === 'boolean') out[f.key] = (a.options ?? [])[0] === 0;
    else out[f.key] = (a.options ?? []).map((i) => f.options?.[i]?.value).filter((v): v is string => typeof v === 'string');
  }
  return out;
}

/** Permission request → hook-like tool name + input. */
export function permissionToTool(p: OcPermission): { tool: string; input: Rec } {
  const action = (p.action ?? 'permission').toLowerCase();
  const res = p.resources ?? [];
  const tool = TOOL[action] ?? p.action ?? 'Permission';
  if (tool === 'Bash') return { tool, input: { command: res.join(' '), ...(p.message ? { description: p.message } : {}) } };
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') return { tool, input: { file_path: res[0] ?? '' } };
  if (tool === 'WebFetch') return { tool, input: { url: res[0] ?? '' } };
  return { tool, input: { resources: res, ...(p.message ? { message: p.message } : {}) } };
}

interface Tracked {
  kind: 'form' | 'perm';
  sessionId: string;
  regId?: string;
  fields?: OcField[];
  cancel?: () => void;
  done?: boolean;
}

export class OpencodeAsks {
  private readonly items = new Map<string, Tracked>();
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly opts: { registry: PermissionRegistry; serviceFile: string; fetchImpl?: typeof fetch }) {}

  start(): void {
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.items.values()) t.cancel?.();
    this.items.clear();
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json?: unknown }> {
    const svc = JSON.parse(readFileSync(this.opts.serviceFile, 'utf8')) as { url: string; password: string };
    const res = await (this.opts.fetchImpl ?? fetch)(svc.url.replace(/\/$/, '') + path, {
      method,
      headers: {
        authorization: 'Basic ' + Buffer.from(`opencode:${svc.password}`).toString('base64'),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text().catch(() => '');
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { ok: res.ok, status: res.status, json };
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const active = Object.keys(((await this.call('GET', '/api/session/active')).json as { data?: Rec } | undefined)?.data ?? {});
      const seen = new Set<string>();
      for (const sid of active) {
        const forms = ((await this.call('GET', `/api/session/${sid}/form`)).json as { data?: OcForm[] } | undefined)?.data ?? [];
        for (const f of forms) {
          const key = `form:${f.id}`;
          seen.add(key);
          if (!this.items.has(key)) this.addForm(key, f);
          else this.retry(key);
        }
        const perms = ((await this.call('GET', `/api/session/${sid}/permission`)).json as { data?: OcPermission[] } | undefined)?.data ?? [];
        for (const p of perms) {
          const key = `perm:${p.id}`;
          seen.add(key);
          if (!this.items.has(key)) this.addPermission(key, p);
          else this.retry(key);
        }
      }
      // Answered in infiniacode (or the session stopped): drop the wait; the registry releases the card.
      for (const [key, t] of this.items) {
        if (seen.has(key)) continue;
        t.cancel?.();
        t.done = true;
        this.items.delete(key);
      }
    } catch (err) {
      log.warn(`infiniacode asks: ${errMsg(err)}`);
    } finally {
      this.busy = false;
    }
  }

  // Kept for items the registry skipped (no page open yet): they are retried on the next polls.
  private pendingRaw = new Map<string, Rec>();

  private retry(key: string): void {
    const t = this.items.get(key);
    const raw = this.pendingRaw.get(key);
    if (t && !t.regId && !t.done && raw) this.register(key, t, raw);
  }

  private addForm(key: string, f: OcForm): void {
    const fields = askableFields(f);
    const t: Tracked = { kind: 'form', sessionId: f.sessionID, fields };
    this.items.set(key, t);
    if (!fields) {
      t.done = true; // free-text / external fields: answer it in infiniacode
      return;
    }
    this.register(key, t, { tool_name: 'AskUserQuestion', tool_input: formToAsk(fields) });
  }

  private addPermission(key: string, p: OcPermission): void {
    const t: Tracked = { kind: 'perm', sessionId: p.sessionID };
    this.items.set(key, t);
    const { tool, input } = permissionToTool(p);
    this.register(key, t, { tool_name: tool, tool_input: input });
  }

  private register(key: string, t: Tracked, raw: Rec): void {
    const r = this.opts.registry.register({ ...raw, provider: 'opencode', session_id: t.sessionId, timeout_ms: HOOK_TIMEOUT_MS });
    if ('skip' in r) {
      if (r.skip === 'no-viewers' || r.skip === 'unknown-session') this.pendingRaw.set(key, raw);
      else t.done = true;
      return;
    }
    this.pendingRaw.delete(key);
    t.regId = r.id;
    void this.waitLoop(key, t);
  }

  private async waitLoop(key: string, t: Tracked): Promise<void> {
    const itemId = key.slice(key.indexOf(':') + 1);
    while (!t.done && t.regId) {
      const w = this.opts.registry.wait(t.regId, WAIT_MS);
      if (!w) {
        this.items.delete(key); // the registry dropped it: register again on the next poll
        return;
      }
      t.cancel = w.cancel;
      const r = await w.result;
      t.cancel = undefined;
      if (t.done || r.status === 'pending') continue;
      t.done = true;
      if (r.status !== 'decided') {
        // M1: released without an answer (no page open, expired, agent briefly gone…): forget it so the next poll
        // registers it again while infiniacode still waits. "Answer in terminal" (Kunal's choice) stays released.
        if (r.reason !== 'terminal' && r.reason !== 'answered') this.items.delete(key);
        return;
      }
      try {
        if (t.kind === 'form') {
          if (r.behavior !== 'answer') return;
          const answer = answersToForm(t.fields ?? [], r.answers);
          const res = await this.call('POST', `/api/session/${t.sessionId}/form/${itemId}/reply`, { answer });
          if (!res.ok) log.warn(`infiniacode asks: form reply refused (HTTP ${res.status})`);
        } else {
          const decision = r.behavior === 'allow' ? 'once' : 'reject';
          const body = { decision, ...(r.behavior === 'deny' && r.message ? { message: r.message } : {}) };
          const res = await this.call('POST', `/api/session/${t.sessionId}/permission/${itemId}/reply`, body);
          if (!res.ok) log.warn(`infiniacode asks: permission reply refused (HTTP ${res.status})`);
        }
      } catch (err) {
        log.warn(`infiniacode asks: reply failed (${errMsg(err)})`);
      }
    }
  }
}

// Source for infiniacode / opencode v2 sessions.
//
// opencode keeps every session in its background service (`opencode service`). The service publishes its URL and
// password in ~/.local/state/opencode/service.json (Basic auth, user "opencode"). This source polls the service's
// HTTP API once a second — the same cadence as the Claude Code watcher — and turns what it sees into the office:
//   room      = the session's working directory (location.directory)
//   main      = a session without parentID; sub = a child session (opencode task/subagent)
//   working   = session listed in /api/session/active; waiting = it also has a pending permission request
//   idle      = recently updated, not running; leaves the office after IDLE_MS without updates
//   activity  = the latest tool call of a running session, described with the shared describeTool().
//   terminal  = a local mirror of each session's finished messages, one JSON per line, in ~/.habblaud/opencode/
//               (HABBLAUD_OPENCODE_MIRROR overrides; files are 0600), read by the terminal with terminal.ts.
// Read-only: it never prompts, answers permissions or writes to opencode.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import { describeTool, maskSecrets, truncate, type ActivityDescription } from '../../../shared/activity';
import type { AccountsService } from '../../accounts/service';
import type { Office } from '../../model/office';
import { errMsg, log } from '../../log';
import type { AgentSource } from '../source';
import type { TerminalParser } from '../terminal';
import { createOpencodeTerminalParser } from './terminal';

const POLL_MS = 1000;
const LIST_EVERY = 5; // full session list every 5 polls; active list every poll
const IDLE_MS = 20 * 60 * 1000; // a session not updated for 20 min leaves the office
const MAIN_ROLE = 'infiniacode';
const MIRROR_EVERY = 2; // refresh a running session's terminal mirror every 2 polls
const MIRROR_FETCH = 60; // catch-up read (first mirror, or a gap since the last one)
const MIRROR_STEP = 4; // steady-state read: just the newest few messages

interface ServiceInfo {
  url: string;
  password: string;
}

interface OcSession {
  id: string;
  parentID?: string;
  title?: string;
  agent?: string;
  location?: { directory?: string };
  time?: { created?: number; updated?: number; archived?: number };
}

interface OcPart {
  type?: string;
  name?: string;
  tool?: string;
  state?: { status?: string; input?: Record<string, unknown> };
}

interface OcMessage {
  id: string;
  type?: string;
  time?: { created?: number; completed?: number };
  content?: OcPart[];
  parts?: OcPart[];
}

interface Tracked {
  session: OcSession;
  inOffice: boolean;
  status: AgentStatus;
  lastActivityKey?: string;
  /** Message ids already in the mirror file (loaded from it on first use). */
  written?: Set<string>;
  /** The mirror is current up to the last idle transition (no refresh needed while idle). */
  mirrorFinal?: boolean;
}

export interface OpencodeSourceOptions {
  accounts: AccountsService;
  office: Office;
  home: string;
  env: NodeJS.ProcessEnv;
}

/** Path of the service descriptor (OPENCODE_SERVICE_FILE overrides it, for tests or another install). */
export function serviceFile(env: NodeJS.ProcessEnv, home: string): string {
  return env.OPENCODE_SERVICE_FILE?.trim() || join(home, '.local', 'state', 'opencode', 'service.json');
}

/** Maps an opencode tool call onto the Claude Code tool names describeTool() understands. */
export function describeOpencodeTool(name: string, input: Record<string, unknown> = {}): ActivityDescription {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const file = s(input.filePath) || s(input.file_path) || s(input.path);
  switch (name) {
    case 'bash':
    case 'shell':
      return describeTool('Bash', { command: s(input.command), description: s(input.description) });
    case 'read':
      return describeTool('Read', { file_path: file });
    case 'edit':
    case 'patch':
    case 'apply_patch':
    case 'multiedit':
      return describeTool('Edit', { file_path: file });
    case 'write':
      return describeTool('Write', { file_path: file });
    case 'grep':
      return describeTool('Grep', { pattern: s(input.pattern) });
    case 'glob':
    case 'list':
      return describeTool('Glob', { pattern: s(input.pattern) || s(input.path) });
    case 'webfetch':
      return describeTool('WebFetch', { url: s(input.url) });
    case 'websearch':
      return describeTool('WebSearch', { query: s(input.query) });
    case 'task':
      return describeTool('Task', { description: s(input.description), subagent_type: s(input.subagent_type) });
    case 'todowrite':
      return describeTool('TodoWrite', { todos: input.todos });
    case 'question':
      return { kind: 'ask', icon: '🙋', text: 'Asking you a question', detail: truncate(maskSecrets(JSON.stringify(input)), 300) };
    case 'skill':
      return describeTool('Skill', { skill: s(input.name) || s(input.skill) });
    case 'execute': {
      // opencode "code mode": a JS snippet calling tools; show which tools it calls.
      const code = s(input.code);
      const called = [...code.matchAll(/tools(?:\.|\[")([\w-]+)(?:"\])?\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`);
      const label = called.length ? [...new Set(called)].slice(0, 2).join(', ') : 'code';
      return { kind: 'other', icon: '🧩', text: truncate(`Running ${label}`, 46), detail: truncate(maskSecrets(code), 300) };
    }
    default:
      return describeTool(name, input);
  }
}

export class OpencodeSource implements AgentSource {
  readonly provider = 'opencode' as const;
  private readonly tracked = new Map<string, Tracked>();
  private timer?: NodeJS.Timeout;
  private tick = 0;
  private busy = false;
  private accountId = 'infiniacode';
  private error?: string;
  private readonly file: string;
  private readonly mirrorDir: string;

  constructor(private readonly opts: OpencodeSourceOptions) {
    this.file = serviceFile(opts.env, opts.home);
    this.mirrorDir = opts.env.HABBLAUD_OPENCODE_MIRROR?.trim() || join(opts.home, '.habblaud', 'opencode');
  }

  async start(): Promise<void> {
    const entries = this.opts.accounts.setProviderAccounts('opencode', [
      {
        dir: this.file,
        detected: { id: 'infiniacode', configDir: this.file, short: 'IC', name: 'infiniacode', color: '#00B4D8' },
      },
    ]);
    this.accountId = entries[0]?.id ?? this.accountId;
    this.opts.office.beginBoot();
    try {
      await this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
    this.timer = setInterval(() => void this.poll(false), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  sources(): SourceInfo[] {
    let sessions = 0;
    for (const t of this.tracked.values()) if (t.inOffice && !t.session.parentID) sessions++;
    const info: SourceInfo = { label: this.accountId, provider: 'opencode', path: this.file, sessions, ok: !this.error };
    if (this.error) info.error = this.error;
    return [info];
  }

  /** The session's mirror file (see mirror()); the terminal tails it with createOpencodeTerminalParser. */
  transcriptPathOf(agentId: string): string | undefined {
    const t = this.tracked.get(agentId);
    const path = this.mirrorPath(agentId);
    return t?.inOffice && existsSync(path) ? path : undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.tracked.has(agentId) ? createOpencodeTerminalParser() : undefined;
  }

  private mirrorPath(sessionId: string): string {
    return join(this.mirrorDir, `${sessionId.replace(/[^\w-]/g, '_')}.jsonl`);
  }

  /** Appends the session's finished messages (oldest first) that the mirror file doesn't have yet. */
  private async mirror(svc: ServiceInfo, t: Tracked): Promise<void> {
    const path = this.mirrorPath(t.session.id);
    if (!t.written) {
      t.written = new Set();
      if (existsSync(path)) {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          try {
            const id = (JSON.parse(line) as { id?: string }).id;
            if (id) t.written.add(id);
          } catch {
            /* partial line */
          }
        }
      }
    }
    let msgs: { data?: OcMessage[] };
    try {
      const url = (n: number) => `/api/session/${t.session.id}/message?limit=${n}&order=desc`;
      // H2: read only the newest few; fall back to the big catch-up read when the mirror is new or the small read
      // has no message we already wrote (a gap: more than MIRROR_STEP messages finished since the last refresh).
      msgs = await this.get(svc, url(t.written.size ? MIRROR_STEP : MIRROR_FETCH));
      const got = msgs.data ?? [];
      if (t.written.size && got.length === MIRROR_STEP && !got.some((m) => t.written!.has(m.id))) msgs = await this.get(svc, url(MIRROR_FETCH));
    } catch {
      return;
    }
    const lines: string[] = [];
    for (const m of [...(msgs.data ?? [])].reverse()) {
      if (t.written.has(m.id)) continue;
      if (m.type === 'assistant' && !m.time?.completed) break; // still streaming: keep order, wait for it
      lines.push(JSON.stringify(m));
      t.written.add(m.id);
    }
    if (!lines.length) return;
    mkdirSync(this.mirrorDir, { recursive: true, mode: 0o700 });
    appendFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });
  }

  // ------------------------------------------------------------------ HTTP

  private service(): ServiceInfo {
    const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ServiceInfo>;
    if (!raw.url || !raw.password) throw new Error('service.json without url/password');
    return { url: raw.url.replace(/\/$/, ''), password: raw.password };
  }

  private async get<T>(svc: ServiceInfo, path: string): Promise<T> {
    const auth = 'Basic ' + Buffer.from(`opencode:${svc.password}`).toString('base64');
    const res = await fetch(svc.url + path, { headers: { authorization: auth, accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`GET ${path.split('?')[0]} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  // ------------------------------------------------------------------ poll

  private async poll(boot: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const svc = this.service(); // re-read every poll: the port/password change when the service restarts
      const active = new Set(Object.keys((await this.get<{ data: Record<string, unknown> }>(svc, '/api/session/active')).data ?? {}));
      const unknownActive = [...active].some((id) => !this.tracked.has(id));
      if (boot || unknownActive || this.tick % LIST_EVERY === 0) {
        const list = await this.get<{ data: OcSession[] }>(svc, '/api/session?limit=60&order=desc');
        const listed = new Set<string>();
        for (const s of list.data ?? []) {
          listed.add(s.id);
          const t = this.tracked.get(s.id);
          if (t) t.session = s;
          else this.tracked.set(s.id, { session: s, inOffice: false, status: 'idle' });
        }
        // Gone from the list (archived / off-boarded, or deleted) and not running: leaves the office now.
        for (const [id, t] of this.tracked) {
          if (listed.has(id) || active.has(id)) continue;
          if (t.inOffice) {
            if (t.session.parentID) this.opts.office.completeSub(id);
            else this.opts.office.closeMain(id);
          }
          this.tracked.delete(id);
        }
      }
      this.tick++;
      const now = Date.now();
      // Mains first, so subs find their parent in the office.
      const ordered = [...this.tracked.values()].sort((a, b) => Number(!!a.session.parentID) - Number(!!b.session.parentID));
      for (const t of ordered) await this.sync(svc, t, active.has(t.session.id), now);
      this.error = undefined;
    } catch (err) {
      const msg = errMsg(err);
      if (msg !== this.error) log.warn(`infiniacode source: ${msg}`);
      this.error = msg;
    } finally {
      this.busy = false;
    }
  }

  private async sync(svc: ServiceInfo, t: Tracked, running: boolean, now: number): Promise<void> {
    const office = this.opts.office;
    const s = t.session;
    const recent = now - (s.time?.updated ?? 0) < IDLE_MS;
    const isSub = !!s.parentID;
    // Archived (off-boarded from the office or in infiniacode): out, even if it was updated a moment ago.
    const archived = !!s.time?.archived;
    const shouldBeIn = !archived && (isSub ? running : running || recent);

    if (!shouldBeIn) {
      if (t.inOffice) {
        if (isSub) office.completeSub(s.id);
        else office.closeMain(s.id);
      }
      t.inOffice = false;
      if (!recent) this.tracked.delete(s.id);
      return;
    }

    let status: AgentStatus = running ? 'working' : 'idle';
    let waitingFor: string | undefined;
    if (running) {
      try {
        const perms = await this.get<{ data?: { action?: string; resources?: string[] }[] }>(svc, `/api/session/${s.id}/permission`);
        const pending = perms.data?.[0];
        if (pending) {
          status = 'waiting';
          waitingFor = truncate(`${pending.action ?? 'permission'} ${(pending.resources ?? []).join(' ')}`.trim(), 60);
        }
      } catch {
        /* permission list is optional */
      }
    }

    if (!t.inOffice) {
      const started = s.time?.created ?? now;
      if (isSub) {
        if (!this.tracked.get(s.parentID!)?.inOffice) return;
        t.inOffice = office.addSub({
          id: s.id,
          parentId: s.parentID!,
          sessionId: s.id,
          role: s.agent || 'subagent',
          title: s.title,
          background: false,
          startedAt: started,
        });
      } else {
        const cwd = s.location?.directory;
        if (!cwd) return;
        office.addMain({
          id: s.id,
          provider: 'opencode',
          account: this.accountId,
          sessionId: s.id,
          cwd,
          role: s.agent && s.agent !== 'build' ? s.agent : MAIN_ROLE,
          startedAt: started,
          status,
          waitingFor,
        });
        t.inOffice = office.has(s.id);
      }
      if (!t.inOffice) return;
    }

    // A running `question` tool means the session is waiting on Kunal, not working.
    if (running && status === 'working' && (await this.latestActivity(svc, t, now)) === 'question') {
      status = 'waiting';
      waitingFor = 'question';
    }
    if (status !== t.status || status === 'waiting') office.setStatus(s.id, status, waitingFor);
    t.status = status;
    // Terminal mirror: on entering, every MIRROR_EVERY polls while running, and once more when it goes idle.
    if (running) {
      t.mirrorFinal = false;
      if (!t.written || this.tick % MIRROR_EVERY === 0) await this.mirror(svc, t);
    } else if (!t.mirrorFinal) {
      await this.mirror(svc, t);
      t.mirrorFinal = true;
    }
  }

  /** Adds the latest tool call as an activity; returns the tool name if that call is still running. */
  private async latestActivity(svc: ServiceInfo, t: Tracked, now: number): Promise<string | undefined> {
    let msgs: { data?: OcMessage[] };
    try {
      msgs = await this.get(svc, `/api/session/${t.session.id}/message?limit=1&order=desc`);
    } catch {
      return;
    }
    const m = msgs.data?.[0];
    if (!m) return;
    const parts = m.content ?? m.parts ?? [];
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      const name = p.name ?? p.tool;
      if (p.type !== 'tool' || !name) continue;
      const key = `${m.id}#${i}`;
      const live = p.state?.status === 'running' || p.state?.status === 'pending';
      if (key === t.lastActivityKey) return live ? name : undefined;
      t.lastActivityKey = key;
      const desc = describeOpencodeTool(name, p.state?.input ?? {});
      const activity: Activity = { id: `oc:${key}`, at: m.time?.created ?? now, tool: name, ...desc };
      this.opts.office.addActivity(t.session.id, activity, live);
      return live ? name : undefined;
    }
    return undefined;
  }
}

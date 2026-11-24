// L4: infiniacode sessions in Habblaud's history (recent sessions, open or closed, and their terminal), backed by
// the terminal mirror files (~/.habblaud/opencode/<session>.jsonl, already masked). One "account": infiniacode.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RecentSession } from '../../../shared/types';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { createOpencodeTerminalParser } from './terminal';

const SESSION_ID = /^ses_[A-Za-z0-9]+$/;
const HEAD_BYTES = 64 * 1024;

export interface OpencodeHistoryOptions {
  dir: string;
  /** The infiniacode account id (as registered by the source). */
  account: () => string | undefined;
  /** The open main agent of a session, if it is in the office. */
  openAgentOf: (account: string, sessionId: string) => string | undefined;
}

/** First user prompt and first timestamp, from the head of a mirror file. */
function head(path: string): { title?: string; firstAt?: number } {
  const buf = Buffer.alloc(HEAD_BYTES);
  const fd = openSync(path, 'r');
  let n = 0;
  try {
    n = readSync(fd, buf, 0, HEAD_BYTES, 0);
  } finally {
    closeSync(fd);
  }
  let title: string | undefined;
  let firstAt: number | undefined;
  for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
    try {
      const m = JSON.parse(line) as { type?: string; text?: string; time?: { created?: number } };
      firstAt ??= m.time?.created;
      if (!title && m.type === 'user' && m.text) title = m.text.split('\n')[0].slice(0, 120);
      if (title && firstAt) break;
    } catch {
      /* partial last line */
    }
  }
  return { title, firstAt };
}

export class OpencodeHistory implements HistoryProvider {
  readonly provider = 'opencode' as const;

  constructor(private readonly opts: OpencodeHistoryOptions) {}

  hasAccount(account: string): boolean {
    return account === this.opts.account();
  }

  async list(): Promise<RecentSession[]> {
    const account = this.opts.account();
    if (!account || !existsSync(this.opts.dir)) return [];
    const out: RecentSession[] = [];
    for (const name of readdirSync(this.opts.dir)) {
      const sessionId = name.replace(/\.jsonl$/, '');
      if (sessionId === name || !SESSION_ID.test(sessionId)) continue;
      const path = join(this.opts.dir, name);
      try {
        const st = statSync(path);
        const { title, firstAt } = head(path);
        const agentId = this.opts.openAgentOf(account, sessionId);
        out.push({ account, provider: 'opencode', sessionId, projectDir: 'infiniacode', title, firstAt, lastAt: st.mtimeMs, size: st.size, open: !!agentId, ...(agentId ? { agentId } : {}) });
      } catch {
        /* removed while listing */
      }
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!SESSION_ID.test(sessionId)) return { status: 400, error: 'invalid infiniacode session id' };
    if (account !== this.opts.account()) return { status: 404, error: 'unknown account' };
    const path = join(this.opts.dir, `${sessionId}.jsonl`);
    if (!existsSync(path)) return { status: 404, error: 'no transcript for this infiniacode session' };
    return { path, createParser: createOpencodeTerminalParser };
  }
}

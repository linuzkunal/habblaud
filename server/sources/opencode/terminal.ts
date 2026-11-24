// Terminal parser for the infiniacode / opencode mirror files (one opencode message JSON per line, written by
// OpencodeSource into ~/.habblaud/opencode/<sessionId>.jsonl). Turns each message into the terminal's entries:
// user prompt, reasoning, answer text, tool call (title in the Claude Code style "Bash(npm test)") and its result.
import type { TerminalEntry } from '../../../shared/types';
import { maskSecrets, truncate } from '../../../shared/activity';
import type { TerminalParser } from '../terminal';

const TEXT_MAX = 20_000;
const THINKING_MAX = 8_000;
const INPUT_MAX = 2_000;
const RESULT_MAX = 4_000;
const RESULT_MAX_LINES = 120;
const TITLE_ARG_MAX = 100;

interface Part {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  state?: { status?: string; input?: Record<string, unknown>; content?: { type?: string; text?: string }[]; error?: unknown };
}

interface Message {
  id?: string;
  type?: string;
  text?: string;
  description?: string;
  time?: { created?: number };
  content?: Part[];
}

const TOOL_NAMES: Record<string, string> = {
  bash: 'Bash', shell: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', patch: 'Edit', apply_patch: 'Edit',
  grep: 'Grep', glob: 'Glob', list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', task: 'Task',
  todowrite: 'TodoWrite', skill: 'Skill', question: 'AskUserQuestion', execute: 'Execute',
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function titleArg(name: string, input: Record<string, unknown>): string {
  const firstLine = (s: string) => s.split('\n').find((l) => l.trim()) ?? '';
  const arg =
    str(input.command) || str(input.filePath) || str(input.file_path) || str(input.path) || str(input.pattern) ||
    str(input.url) || str(input.query) || str(input.description) || str(input.name) ||
    (name === 'execute' ? firstLine(str(input.code)) : '');
  return truncate(maskSecrets(arg.replace(/\s+/g, ' ').trim()), TITLE_ARG_MAX);
}

function inputText(name: string, input: Record<string, unknown>): string | undefined {
  const body = str(input.command) || str(input.code) || str(input.newString) || str(input.content);
  const raw = body || (Object.keys(input).length ? JSON.stringify(input, null, 2) : '');
  return raw ? truncate(maskSecrets(raw), INPUT_MAX) : undefined;
}

function resultText(p: Part): { text: string; truncated: boolean } | undefined {
  const st = p.state;
  if (!st || (st.status !== 'completed' && st.status !== 'error')) return undefined;
  let text = (st.content ?? []).map((c) => str(c.text)).filter(Boolean).join('\n');
  if (!text && st.error !== undefined) text = typeof st.error === 'string' ? st.error : JSON.stringify(st.error);
  text = maskSecrets(text);
  let truncated = false;
  const lines = text.split('\n');
  if (lines.length > RESULT_MAX_LINES) {
    text = lines.slice(0, RESULT_MAX_LINES).join('\n');
    truncated = true;
  }
  if (text.length > RESULT_MAX) {
    text = text.slice(0, RESULT_MAX);
    truncated = true;
  }
  return { text, truncated };
}

/** Converts one opencode message into terminal entries (exported for tests). */
export function opencodeEntries(m: Message): TerminalEntry[] {
  const id = str(m.id);
  const at = m.time?.created ?? 0;
  if (!id) return [];
  switch (m.type) {
    case 'user': {
      const text = str(m.text);
      return text ? [{ kind: 'user', id, at, text: truncate(maskSecrets(text), TEXT_MAX) }] : [];
    }
    case 'system': {
      const text = str(m.description) || str(m.text);
      return text ? [{ kind: 'system', id, at, text: truncate(text.split('\n')[0], 200), level: 'info' }] : [];
    }
    case 'assistant': {
      const out: TerminalEntry[] = [];
      (m.content ?? []).forEach((p, i) => {
        const pid = p.id || `${id}#${i}`;
        if (p.type === 'reasoning') {
          const t = str(p.text);
          out.push({ kind: 'thinking', id: pid, at, ...(t ? { text: truncate(t, THINKING_MAX) } : {}) });
        } else if (p.type === 'text') {
          const t = str(p.text);
          if (t.trim()) out.push({ kind: 'assistant', id: pid, at, text: truncate(maskSecrets(t), TEXT_MAX) });
        } else if (p.type === 'tool' && p.name) {
          const input = p.state?.input ?? {};
          const tool = TOOL_NAMES[p.name] ?? p.name;
          const arg = titleArg(p.name, input);
          const inp = inputText(p.name, input);
          out.push({ kind: 'tool', id: pid, at, tool, title: arg ? `${tool}(${arg})` : tool, ...(inp ? { input: inp } : {}) });
          const r = resultText(p);
          if (r) {
            out.push({
              kind: 'result', id: `${pid}:r`, at, toolUseId: pid, text: r.text,
              ...(p.state?.status === 'error' ? { error: true } : {}), ...(r.truncated ? { truncated: true } : {}),
            });
          }
        }
      });
      return out;
    }
    default:
      return [];
  }
}

export function createOpencodeTerminalParser(): TerminalParser {
  return {
    push(line: string): TerminalEntry[] {
      try {
        return opencodeEntries(JSON.parse(line) as Message);
      } catch {
        return [];
      }
    },
  };
}

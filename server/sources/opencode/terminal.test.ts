import { describe, expect, it } from 'vitest';
import { opencodeEntries } from './terminal';

describe('opencodeEntries', () => {
  it('user prompt', () => {
    expect(opencodeEntries({ id: 'm1', type: 'user', text: 'fix the bug', time: { created: 1 } })).toEqual([
      { kind: 'user', id: 'm1', at: 1, text: 'fix the bug' },
    ]);
  });
  it('assistant: reasoning, text, tool + result', () => {
    const e = opencodeEntries({
      id: 'm2', type: 'assistant', time: { created: 2 },
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'Running tests' },
        { type: 'tool', id: 't1', name: 'shell', state: { status: 'completed', input: { command: 'go test ./...' }, content: [{ type: 'text', text: 'ok' }] } },
      ],
    });
    expect(e.map((x) => x.kind)).toEqual(['thinking', 'assistant', 'tool', 'result']);
    expect(e[2]).toMatchObject({ tool: 'Bash', title: 'Bash(go test ./...)' });
    expect(e[3]).toMatchObject({ toolUseId: 't1', text: 'ok' });
  });
  it('keeps line breaks in answers, prompts and commands (markdown tables/headings need them)', () => {
    const md = '## Ready\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    const e = opencodeEntries({ id: 'm5', type: 'assistant', time: { created: 5 }, content: [{ type: 'text', text: md }, { type: 'tool', id: 't5', name: 'shell', state: { status: 'running', input: { command: 'cd x\nnpm test' } } }] });
    expect(e[0]).toMatchObject({ kind: 'assistant', text: md });
    expect(e[1]).toMatchObject({ input: 'cd x\nnpm test' });
    expect(opencodeEntries({ id: 'm6', type: 'user', text: 'a\nb', time: { created: 6 } })[0]).toMatchObject({ text: 'a\nb' });
  });
  it('tool error is flagged', () => {
    const e = opencodeEntries({ id: 'm3', type: 'assistant', content: [{ type: 'tool', id: 't2', name: 'read', state: { status: 'error', input: { filePath: '/x' }, error: 'not found' } }] });
    expect(e[1]).toMatchObject({ kind: 'result', error: true, text: 'not found' });
  });
  it('ignores idle markers and junk', () => {
    expect(opencodeEntries({ id: 'm4', type: 'idle' })).toEqual([]);
  });
});

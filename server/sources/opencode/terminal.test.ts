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
  it('tool error is flagged', () => {
    const e = opencodeEntries({ id: 'm3', type: 'assistant', content: [{ type: 'tool', id: 't2', name: 'read', state: { status: 'error', input: { filePath: '/x' }, error: 'not found' } }] });
    expect(e[1]).toMatchObject({ kind: 'result', error: true, text: 'not found' });
  });
  it('ignores idle markers and junk', () => {
    expect(opencodeEntries({ id: 'm4', type: 'idle' })).toEqual([]);
  });
});

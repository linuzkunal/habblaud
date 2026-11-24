import { describe, expect, it } from 'vitest';
import { answersToForm, askableFields, formToAsk, permissionToTool, type OcForm } from './opencode';

const form: OcForm = {
  id: 'frm_1', sessionID: 'ses_1', title: 'Questions', metadata: { kind: 'question' },
  fields: [
    { key: 'q0', type: 'multiselect', title: 'Fix scope', description: 'How do you want me to proceed?', options: [
      { value: 'fix1', label: 'Fix #1', description: 'csv' }, { value: 'fix2', label: 'Fix #2' }, { value: 'fix3', label: 'Fix #3' }] },
    { key: 'q1', type: 'boolean', title: 'Push', description: 'Open a PR afterwards?' },
  ],
};

describe('infiniacode asks bridge', () => {
  it('form → AskUserQuestion input', () => {
    const f = askableFields(form)!;
    const ask = formToAsk(f) as { questions: { question: string; multiSelect: boolean; options: { label: string }[] }[] };
    expect(ask.questions[0]).toMatchObject({ question: 'How do you want me to proceed?', multiSelect: true });
    expect(ask.questions[0].options.map((o) => o.label)).toEqual(['Fix #1', 'Fix #2', 'Fix #3']);
    expect(ask.questions[1].options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });
  it('office answers (by position) → form answer (by key)', () => {
    const f = askableFields(form)!;
    expect(answersToForm(f, [{ question: 0, options: [0, 2] }, { question: 1, options: [1] }])).toEqual({ q0: ['fix1', 'fix3'], q1: false });
  });
  it('free-text fields stay infiniacode-only', () => {
    expect(askableFields({ ...form, fields: [{ key: 'q', type: 'string', title: 'Why?' }] })).toBeUndefined();
  });
  it('permission → tool view', () => {
    expect(permissionToTool({ id: 'p', sessionID: 's', action: 'bash', resources: ['go', 'test', './...'] })).toEqual({ tool: 'Bash', input: { command: 'go test ./...' } });
    expect(permissionToTool({ id: 'p', sessionID: 's', action: 'edit', resources: ['/a/b.go'] }).input).toEqual({ file_path: '/a/b.go' });
  });
});

import { PermissionRegistry } from './registry';
describe('H1: no free-text "Other" answers for infiniacode', () => {
  it('the registry refuses an infiniacode answer carrying "Other" text, accepts options', () => {
    const agent = { id: 'ses_q', kind: 'main', provider: 'opencode', status: 'waiting', sessionId: 'ses_q' } as never;
    const office = { get: (id: string) => (id === 'ses_q' ? agent : undefined), list: () => [agent], markDirty() {}, addActivity() {}, noticePermission() {} };
    const reg = new PermissionRegistry({ office, viewers: () => 1 } as never);
    const r = reg.register({ provider: 'opencode', session_id: 'ses_q', tool_name: 'AskUserQuestion', tool_input: formToAsk(askableFields(form)!) });
    if (!('id' in r)) throw new Error('not registered: ' + JSON.stringify(r));
    expect(reg.decide(r.id, { behavior: 'answer', answers: [{ question: 0, other: 'something else' }, { question: 1, options: [0] }] })).toBe('invalid-answer');
    expect(reg.decide(r.id, { behavior: 'answer', answers: [{ question: 0, options: [1] }, { question: 1, options: [0] }] })).toBe('ok');
  });
});

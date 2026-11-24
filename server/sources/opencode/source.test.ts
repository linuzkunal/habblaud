import { describe, expect, it } from 'vitest';
import { describeOpencodeTool } from './source';

describe('describeOpencodeTool', () => {
  it('maps opencode tools onto the shared descriptions', () => {
    expect(describeOpencodeTool('read', { filePath: '/x/App.tsx' }).kind).toBe('read');
    expect(describeOpencodeTool('edit', { filePath: '/x/App.tsx' }).kind).toBe('edit');
    expect(describeOpencodeTool('grep', { pattern: 'warden' }).kind).toBe('search');
    expect(describeOpencodeTool('shell', { command: 'go test ./...' }).detail).toContain('go test');
  });
  it('names the tools a code-mode snippet calls', () => {
    const d = describeOpencodeTool('execute', { code: 'await tools["atlas-ping"].browser_read_tab({tab_id:1})' });
    expect(d.text).toContain('atlas-ping.browser_read_tab');
  });
  it('falls back for unknown tools', () => {
    expect(describeOpencodeTool('mystery', {}).text.length).toBeGreaterThan(0);
  });
});

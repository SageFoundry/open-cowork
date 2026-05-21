import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsToolsPath = path.resolve(
  process.cwd(),
  'src/renderer/components/settings/SettingsTools.tsx'
);

describe('SettingsTools output compression UI', () => {
  it('wires compression setting and stats actions', () => {
    const source = fs.readFileSync(settingsToolsPath, 'utf8');

    expect(source).toContain('toolOutputCompressionLevel');
    expect(source).toContain('toolCompression');
    expect(source).toContain('tools.compression.statsTitle');
    expect(source).toContain('resetStats');
    expect(source).toContain('ConfirmOverlay');
    expect(source).not.toContain('window.confirm');
  });
});

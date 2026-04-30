import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ServerEvent } from '../src/renderer/types';
import type { BackgroundTaskRow, DatabaseInstance } from '../src/main/db/database';

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-bg-tests-'));

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
  },
  shell: {
    openPath: vi.fn(async () => ''),
    openExternal: vi.fn(async () => undefined),
  },
}));

vi.mock('../src/main/tools/windows-bash-executor', () => ({
  detectGitBash: () => 'C:\\Program Files\\Git\\bin\\bash.exe',
}));

vi.mock('../src/main/sandbox/sandbox-adapter', () => ({
  getSandboxAdapter: () => ({
    isWSL: false,
    wslStatus: undefined,
  }),
}));

import {
  BackgroundTaskService,
  detectUrl,
} from '../src/main/background/background-task-service';
const backgroundTaskServicePath = path.resolve(
  process.cwd(),
  'src/main/background/background-task-service.ts'
);
const backgroundTaskServiceContent = fs.readFileSync(backgroundTaskServicePath, 'utf8');

function createBackgroundTaskDb(initialRows: BackgroundTaskRow[] = []): DatabaseInstance {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));

  return {
    backgroundTasks: {
      create: (task) => rows.set(task.id, { ...task }),
      update: (id, updates) => {
        const current = rows.get(id);
        if (!current) {
          throw new Error(`Missing task row: ${id}`);
        }
        rows.set(id, {
          ...current,
          ...updates,
          updated_at: Date.now(),
        });
      },
      get: (id) => rows.get(id),
      getAll: () => Array.from(rows.values()),
      delete: (id) => rows.delete(id),
    },
  } as unknown as DatabaseInstance;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BackgroundTaskService', () => {
  it('detects local URLs from command output', () => {
    expect(detectUrl('ready on localhost:5173')).toBe('http://localhost:5173');
    expect(detectUrl('Server at http://127.0.0.1:3000/path')).toBe(
      'http://127.0.0.1:3000/path'
    );
    expect(detectUrl('no url here')).toBeNull();
  });

  it('starts and stops a background task without blocking and persists task metadata', async () => {
    const db = createBackgroundTaskDb();
    const events: ServerEvent[] = [];
    const service = new BackgroundTaskService(db, (event) => events.push(event));
    vi.spyOn(service as never, 'spawnDetached').mockReturnValue({
      pid: 4321,
      unref: vi.fn(),
    } as never);
    vi.spyOn(service as never, 'attachLogWatcher').mockImplementation(() => undefined);
    vi.spyOn(service as never, 'terminateProcess').mockResolvedValue(true);
    vi.spyOn(service as never, 'isProcessAlive').mockResolvedValue(false);

    const task = await service.startTask({
      command: 'npm run dev',
      cwd: userDataDir,
      title: 'dev server',
    });

    expect(task.status).toBe('running');
    expect(task.pid).toBe(4321);
    expect(fs.existsSync(task.logPath)).toBe(true);

    fs.writeFileSync(task.logPath, 'ready http://localhost:43123', 'utf8');
    expect(service.getLogTail(task.id, 4000)).toContain('http://localhost:43123');

    const stoppedTask = await service.stopTask(task.id);
    expect(stoppedTask?.status).toBe('completed');
    expect(events.filter((event) => event.type === 'tasks.updated').length).toBeGreaterThan(0);
    },
    20000
  );

  it('marks restored missing processes as lost during initialization', async () => {
    const now = Date.now();
    const db = createBackgroundTaskDb([
      {
        id: 'orphan-task',
        title: 'orphan',
        command: 'node never-existed.js',
        args_json: '[]',
        cwd: userDataDir,
        status: 'running',
        pid: 999999,
        started_at: now - 1000,
        ended_at: null,
        exit_code: null,
        log_path: path.join(userDataDir, 'orphan.log'),
        detected_url: null,
        source_session_id: null,
        created_at: now - 1000,
        updated_at: now - 1000,
      },
    ]);

    const events: ServerEvent[] = [];
    const service = new BackgroundTaskService(db, (event) => events.push(event));
    vi.spyOn(service as never, 'isProcessAlive').mockResolvedValue(false);
    vi.spyOn(service as never, 'attachLogWatcher').mockImplementation(() => undefined);
    service.initialize();

    await vi.waitFor(() => {
      expect(service.getTask('orphan-task')?.status).toBe('lost');
    });
    expect(events.some((event) => event.type === 'tasks.updated')).toBe(true);
  });

  it('hydrates detected URL from existing log content during initialization', async () => {
    const now = Date.now();
    const logPath = path.join(userDataDir, `hydrate-${Date.now()}.log`);
    fs.writeFileSync(logPath, 'ready at localhost:4555', 'utf8');
    const db = createBackgroundTaskDb([
      {
        id: 'live-task',
        title: 'live',
        command: process.platform === 'win32' ? 'node' : 'node',
        args_json: '[]',
        cwd: userDataDir,
        status: 'running',
        pid: process.pid,
        started_at: now - 1000,
        ended_at: null,
        exit_code: null,
        log_path: logPath,
        detected_url: null,
        source_session_id: null,
        created_at: now - 1000,
        updated_at: now - 1000,
      },
    ]);

    const service = new BackgroundTaskService(db, () => undefined);
    vi.spyOn(service as never, 'isProcessAlive').mockResolvedValue(true);
    service.initialize();

    await vi.waitFor(() => {
      expect(service.getTask('live-task')?.detectedUrl).toBe('http://localhost:4555');
    });
    service.shutdown();
  });

  it('waits for a port and writes detectedUrl when the service becomes ready', async () => {
    const db = createBackgroundTaskDb([
      {
        id: 'wait-task',
        title: 'wait',
        command: 'pnpm dev',
        args_json: '[]',
        cwd: userDataDir,
        status: 'running',
        pid: process.pid,
        started_at: Date.now(),
        ended_at: null,
        exit_code: null,
        log_path: path.join(userDataDir, `wait-${Date.now()}.log`),
        detected_url: null,
        source_session_id: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]);

    const service = new BackgroundTaskService(db, () => undefined);
    vi.spyOn(service as never, 'isProcessAlive').mockReturnValue(true);

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }

    const ready = await service.waitForPort('wait-task', address.port, 2000);
    expect(ready).toBe(true);
    expect(service.getTask('wait-task')?.detectedUrl).toBe(`http://localhost:${address.port}`);

    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    service.shutdown();
  });

  it('prefers Git Bash or WSL semantics over PowerShell for detached Windows commands', () => {
    expect(backgroundTaskServiceContent).toContain("const gitBashPath = detectGitBash();");
    expect(backgroundTaskServiceContent).toContain("if (sandbox.isWSL && sandbox.wslStatus?.distro)");
    expect(backgroundTaskServiceContent).toContain("env: { ...process.env, OPEN_COWORK_BASH_BACKEND: 'git-bash' }");
    expect(backgroundTaskServiceContent).toContain("['-lc', bashCommand]");
  });
});

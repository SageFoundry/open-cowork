import { DEFAULT_PROJECT_ID, type ProjectSummary, type Session } from '../types';

export function normalizeProjectPath(cwd?: string | null): string | null {
  const trimmed = cwd?.trim();
  if (!trimmed) return null;

  const slashNormalized = trimmed.replace(/\\/g, '/');
  const isRootPath = slashNormalized === '/' || /^[a-zA-Z]:\/$/.test(slashNormalized);
  const normalized = isRootPath ? slashNormalized : slashNormalized.replace(/\/+$/g, '');

  return normalized.toLowerCase();
}

export function getProjectIdForCwd(cwd?: string | null): string {
  const normalized = normalizeProjectPath(cwd);
  return normalized ? `cwd:${normalized}` : DEFAULT_PROJECT_ID;
}

export function getProjectName(cwd?: string | null, defaultName = 'Default Project'): string {
  const trimmed = cwd?.trim();
  if (!trimmed) return defaultName;

  const normalized = trimmed.replace(/\\/g, '/').replace(/\/+$/g, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized || defaultName;
}

export function buildProjectSummaries(
  sessions: Session[],
  defaultName = 'Default Project'
): ProjectSummary[] {
  const projects = new Map<string, ProjectSummary>();

  projects.set(DEFAULT_PROJECT_ID, {
    id: DEFAULT_PROJECT_ID,
    name: defaultName,
    cwd: undefined,
    sessionCount: 0,
    lastUpdatedAt: 0,
    runningCount: 0,
  });

  for (const session of sessions) {
    const projectId = getProjectIdForCwd(session.cwd);
    const existing = projects.get(projectId);
    const updatedAt = session.updatedAt || session.createdAt || 0;

    if (existing) {
      existing.sessionCount += 1;
      existing.lastUpdatedAt = Math.max(existing.lastUpdatedAt, updatedAt);
      existing.runningCount += session.status === 'running' ? 1 : 0;
      if (!existing.cwd && projectId !== DEFAULT_PROJECT_ID) {
        existing.cwd = session.cwd;
      }
      continue;
    }

    projects.set(projectId, {
      id: projectId,
      name: getProjectName(session.cwd, defaultName),
      cwd: session.cwd,
      sessionCount: 1,
      lastUpdatedAt: updatedAt,
      runningCount: session.status === 'running' ? 1 : 0,
    });
  }

  return Array.from(projects.values()).sort((a, b) => {
    if (a.sessionCount === 0 && b.sessionCount > 0) return 1;
    if (b.sessionCount === 0 && a.sessionCount > 0) return -1;
    return b.lastUpdatedAt - a.lastUpdatedAt || a.name.localeCompare(b.name);
  });
}

export function getProjectSessions(sessions: Session[], projectId: string | null): Session[] {
  if (!projectId) return sessions;
  return sessions.filter((session) => getProjectIdForCwd(session.cwd) === projectId);
}

import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_ID, type MountedPath, type Session } from '../../renderer/types';
import {
  buildProjectSummaries,
  getProjectIdForCwd,
  getProjectSessions,
} from '../../renderer/utils/projects';

function makeSession(id: string, cwd?: string, updatedAt = 1000): Session {
  return {
    id,
    title: `Session ${id}`,
    status: 'idle',
    createdAt: updatedAt,
    updatedAt,
    cwd,
    mountedPaths: [] as MountedPath[],
    allowedTools: [],
    memoryEnabled: false,
  };
}

describe('project summaries', () => {
  it('derives projects from session working directories', () => {
    const projects = buildProjectSummaries([
      makeSession('a', 'C:\\work\\alpha', 1000),
      makeSession('b', 'C:/work/alpha/', 2000),
      { ...makeSession('c', '/repo/beta', 3000), status: 'running' },
    ]);

    const alpha = projects.find((project) => project.name === 'alpha');
    const beta = projects.find((project) => project.name === 'beta');

    expect(alpha?.sessionCount).toBe(2);
    expect(alpha?.lastUpdatedAt).toBe(2000);
    expect(beta?.sessionCount).toBe(1);
    expect(beta?.runningCount).toBe(1);
  });

  it('places sessions without cwd in the default project', () => {
    const projects = buildProjectSummaries([makeSession('a', undefined, 1000)]);
    const defaultProject = projects.find((project) => project.id === DEFAULT_PROJECT_ID);

    expect(defaultProject?.name).toBe('Default Project');
    expect(defaultProject?.sessionCount).toBe(1);
    expect(defaultProject?.cwd).toBeUndefined();
  });

  it('keeps an empty default project while removed cwd projects disappear', () => {
    const projects = buildProjectSummaries([]);

    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe(DEFAULT_PROJECT_ID);
    expect(projects[0].sessionCount).toBe(0);
  });

  it('filters sessions by project id', () => {
    const sessions = [
      makeSession('a', 'C:\\work\\alpha'),
      makeSession('b', '/repo/beta'),
      makeSession('c'),
    ];

    expect(getProjectSessions(sessions, getProjectIdForCwd('c:/work/alpha/')).map((s) => s.id)).toEqual([
      'a',
    ]);
    expect(getProjectSessions(sessions, DEFAULT_PROJECT_ID).map((s) => s.id)).toEqual(['c']);
  });
});

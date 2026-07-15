import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Moon,
  Sun,
  Monitor,
  Settings,
  Search as SearchIcon,
  Plus,
  ListChecks,
  Check,
  Folder,
  Pencil,
  Server,
} from 'lucide-react';
import { DEFAULT_PROJECT_ID, type ProjectSummary, type Session } from '../types';
import {
  buildProjectSummaries,
  getProjectIdForCwd,
  getProjectSessions,
} from '../utils/projects';
import { UpdateBadge } from './UpdateBadge';

import sidebarLogoSrc from '../assets/logo.png';

const INITIAL_MESSAGES_PAGE_SIZE = 20;

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function Sidebar() {
  const { t } = useTranslation();
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const settings = useAppStore((s) => s.settings);
  const sessionStates = useAppStore((s) => s.sessionStates);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const setActiveProject = useAppStore((s) => s.setActiveProject);
  const setMessages = useAppStore((s) => s.setMessages);
  const setMessagePagination = useAppStore((s) => s.setMessagePagination);
  const setTraceSteps = useAppStore((s) => s.setTraceSteps);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const isConfigured = useAppStore((s) => s.isConfigured);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const mainView = useAppStore((s) => s.mainView);
  const setMainView = useAppStore((s) => s.setMainView);
  const {
    deleteSession,
    batchDeleteSessions,
    renameSession,
    getSessionMessages,
    getSessionTraceSteps,
    isElectron,
  } = useIPC();
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const skipRenameCommitRef = useRef(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());

  const normalizedQuery = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);
  const projects = useMemo(
    () => buildProjectSummaries(sessions, t('sidebar.defaultProject')),
    [sessions, t]
  );
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) || null,
    [activeProjectId, projects]
  );
  const filteredSessions = useMemo(() => {
    if (!normalizedQuery) return sessions;
    return sessions.filter((session) => session.title.toLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, sessions]);
  const filteredProjects = useMemo(() => {
    if (!normalizedQuery) return projects;
    return projects.filter((project) => {
      const projectText = `${project.name} ${project.cwd || ''}`.toLowerCase();
      const hasMatchingSession = getProjectSessions(sessions, project.id).some((session) =>
        session.title.toLowerCase().includes(normalizedQuery)
      );
      return projectText.includes(normalizedQuery) || hasMatchingSession;
    });
  }, [normalizedQuery, projects, sessions]);

  const visibleSessionIds = useMemo(() => filteredSessions.map((s) => s.id), [filteredSessions]);
  const allVisibleSelected =
    visibleSessionIds.length > 0 && visibleSessionIds.every((id) => selectedIds.has(id));

  useEffect(() => {
    if (sidebarCollapsed && isSelectMode) {
      setIsSelectMode(false);
      setSelectedIds(new Set());
      setShowDeleteConfirm(false);
    }
  }, [sidebarCollapsed, isSelectMode]);

  useEffect(() => {
    if (!isSelectMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsSelectMode(false);
        setSelectedIds(new Set());
        setShowDeleteConfirm(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSelectMode]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = () => setContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('click', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!activeProjectId || activeProject || activeProjectId === DEFAULT_PROJECT_ID) return;
    setActiveProject(null);
    setActiveSession(null);
    setIsSelectMode(false);
    setSelectedIds(new Set());
    setShowDeleteConfirm(false);
  }, [activeProject, activeProjectId, setActiveProject, setActiveSession]);

  useEffect(() => {
    setExpandedProjectIds((prev) => {
      const validIds = new Set(projects.map((project) => project.id));
      const next = new Set(Array.from(prev).filter((id) => validIds.has(id)));
      if (activeProjectId && validIds.has(activeProjectId)) next.add(activeProjectId);
      if (next.size === 0 && projects[0]) next.add(projects[0].id);
      return next;
    });
  }, [activeProjectId, projects]);

  useEffect(() => {
    if (isSelectMode) {
      setSelectedIds(new Set());
    }
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const exitSelectMode = useCallback(() => {
    setIsSelectMode(false);
    setSelectedIds(new Set());
    setShowDeleteConfirm(false);
  }, []);

  const toggleSelectSession = useCallback((sessionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (allVisibleSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleSessionIds) next.delete(id);
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleSessionIds) next.add(id);
        return next;
      });
    }
  }, [allVisibleSelected, visibleSessionIds]);

  const handleBatchDelete = useCallback(() => {
    const visibleSet = new Set(visibleSessionIds);
    const ids = Array.from(selectedIds).filter((id) => visibleSet.has(id));
    if (ids.length === 0) return;
    batchDeleteSessions(ids);
    exitSelectMode();
  }, [selectedIds, visibleSessionIds, batchDeleteSessions, exitSelectMode]);

  const handleSessionClick = useCallback(
    async (sessionId: string) => {
      setShowSettings(false);
      setMainView('chat');
      const session = sessions.find((item) => item.id === sessionId);
      if (session) {
        setActiveProject(getProjectIdForCwd(session.cwd));
      }

      if (activeSessionId === sessionId) return;

      setActiveSession(sessionId);

      const existingState = sessionStates[sessionId];
      const existingMessages = existingState?.messages;
      if (
        (!existingState?.messagePagination.initialLoaded || !existingMessages) &&
        isElectron
      ) {
        try {
          const page = await getSessionMessages(sessionId, {
            limit: INITIAL_MESSAGES_PAGE_SIZE,
          });
          setMessages(sessionId, page.messages);
          setMessagePagination(sessionId, {
            hasMore: page.hasMore,
            oldestTimestamp: page.oldestTimestamp,
            initialLoaded: true,
            loadingOlder: false,
          });
        } catch (error) {
          console.error('[Sidebar] Failed to load messages:', error);
        }
      }

      const existingSteps = sessionStates[sessionId]?.traceSteps;
      if ((!existingSteps || existingSteps.length === 0) && isElectron) {
        try {
          const steps = await getSessionTraceSteps(sessionId);
          setTraceSteps(sessionId, steps || []);
        } catch (error) {
          console.error('[Sidebar] Failed to load trace steps:', error);
        }
      }
    },
    [
      activeSessionId,
      getSessionMessages,
      getSessionTraceSteps,
      isElectron,
      sessionStates,
      sessions,
      setActiveProject,
      setActiveSession,
      setMessages,
      setShowSettings,
      setMainView,
      setMessagePagination,
      setTraceSteps,
    ]
  );

  const handleNewSession = (projectId?: string) => {
    if (projectId) {
      setActiveProject(projectId);
      setExpandedProjectIds((prev) => new Set(prev).add(projectId));
    } else if (!activeProjectId) {
      setActiveProject(null);
    }
    setActiveSession(null);
    setShowSettings(false);
    setMainView('chat');
  };

  const handleProjectToggle = (projectId: string) => {
    setActiveProject(projectId);
    setShowSettings(false);
    setMainView('chat');
    setExpandedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  const handleDeleteSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    setContextMenu(null);
    deleteSession(sessionId);
  };

  const handleSessionContextMenu = (event: React.MouseEvent, session: Session) => {
    if (isSelectMode) return;
    event.preventDefault();
    event.stopPropagation();
    setHoveredSession(session.id);
    setContextMenu({
      session,
      x: Math.min(event.clientX, window.innerWidth - 180),
      y: Math.min(event.clientY, window.innerHeight - 96),
    });
  };

  const startRenamingSession = (session: Session) => {
    setContextMenu(null);
    skipRenameCommitRef.current = false;
    setEditingSessionId(session.id);
    setEditingTitle(session.title);
  };

  const cancelRenamingSession = () => {
    skipRenameCommitRef.current = true;
    setEditingSessionId(null);
    setEditingTitle('');
  };

  const commitRenamingSession = async () => {
    if (skipRenameCommitRef.current) {
      skipRenameCommitRef.current = false;
      setEditingSessionId(null);
      setEditingTitle('');
      return;
    }
    if (!editingSessionId) return;
    const session = sessions.find((item) => item.id === editingSessionId);
    const nextTitle = editingTitle.trim().replace(/\s+/g, ' ').slice(0, 120);
    cancelRenamingSession();
    if (!session || !nextTitle || nextTitle === session.title) return;
    try {
      await renameSession(session.id, nextTitle);
    } catch (error) {
      console.error('[Sidebar] Failed to rename session:', error);
    }
  };

  const toggleTheme = () => {
    const next =
      settings.theme === 'dark' ? 'light' : settings.theme === 'light' ? 'system' : 'dark';
    updateSettings({ theme: next });
  };

  const themeIcon =
    settings.theme === 'dark' ? (
      <Sun className="w-4 h-4" />
    ) : settings.theme === 'light' ? (
      <Moon className="w-4 h-4" />
    ) : (
      <Monitor className="w-4 h-4" />
    );

  if (sidebarCollapsed) {
    return (
      <aside className="w-[4.5rem] bg-surface/96 border-r border-border-muted flex flex-col overflow-hidden">
        <div className="px-3 pt-4 pb-3 flex flex-col items-center gap-2 border-b border-border-muted">
          <button
            onClick={toggleSidebar}
            className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary"
            title={t('context.expandPanel')}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => handleNewSession(activeProjectId || undefined)}
            className="w-9 h-9 rounded-2xl flex items-center justify-center bg-background hover:bg-surface-hover transition-colors text-text-primary border border-border-subtle"
            title={t('sidebar.newTask')}
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-3 py-4">
          <button
            onClick={toggleSidebar}
            className="rounded-2xl px-2 py-3 text-[11px] leading-4 text-center text-text-muted hover:bg-surface-hover transition-colors"
            title={t('sidebar.expandToView')}
          >
            {t('sidebar.expandToView')}
          </button>
        </div>

        <div className="px-3 py-3 border-t border-border-muted flex flex-col items-center gap-2">
          <button
            onClick={toggleTheme}
            className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary"
            title={t('sidebar.themeToggle')}
          >
            {themeIcon}
          </button>
          <UpdateBadge />
          <button
            onClick={() => { setShowSettings(false); setMainView('servers'); }}
            className={`w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary ${mainView === 'servers' ? 'bg-surface-hover text-text-primary' : ''}`}
            title="服务器"
          >
            <Server className="w-4 h-4" />
          </button>
          <button
            onClick={() => { setMainView('chat'); setShowSettings(true); }}
            className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary relative"
            title={t('sidebar.settings')}
          >
            <Settings className="w-4 h-4" />
            {!isConfigured && (
              <span className="absolute right-2 top-2 w-1.5 h-1.5 rounded-full bg-accent" />
            )}
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-[17.5rem] bg-surface/96 border-r border-border-muted flex flex-col overflow-hidden">
      <div className="px-4 pt-5 pb-4 border-b border-border-muted">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <img
              src={sidebarLogoSrc}
              alt={t('common.appLogoAlt')}
              className="w-10 h-10 rounded-2xl object-cover border border-border-subtle bg-background/60 flex-shrink-0"
            />
            <div className="min-w-0">
              <h1 className="text-[1.34rem] leading-none font-semibold tracking-[-0.035em] text-text-primary">
                Open Cowork
              </h1>
            </div>
          </div>
          <button
            onClick={toggleSidebar}
            className="w-8 h-8 rounded-xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary flex-shrink-0"
            title={t('context.collapsePanel')}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>

        <button
          onClick={() => handleNewSession(activeProjectId || undefined)}
          className="mt-3 w-full flex items-center gap-2 rounded-xl bg-background/60 px-3 py-2 text-left text-text-primary hover:bg-surface-hover transition-colors"
        >
          <Plus className="w-4 h-4 text-text-secondary flex-shrink-0" />
          <span className="text-[13px] font-medium">{t('sidebar.newTask')}</span>
        </button>

        <div className="mt-2 flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('sidebar.search')}
              className="w-full rounded-xl border border-transparent bg-background/50 pl-9 pr-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-border focus:bg-background transition-colors"
            />
          </div>
          {sessions.length > 0 && (
            <button
              onClick={() => {
                if (isSelectMode) {
                  exitSelectMode();
                } else {
                  setIsSelectMode(true);
                }
              }}
              className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors ${
                isSelectMode
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
              }`}
              title={t('sidebar.manage')}
            >
              <ListChecks className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        <div className="space-y-2">
          {filteredProjects.length === 0 ? (
            <div className="px-3 py-6">
              <p className="text-sm text-text-secondary">{t('sidebar.noProjects')}</p>
              <p className="mt-1 text-xs leading-5 text-text-muted">{t('sidebar.noProjectsHint')}</p>
            </div>
          ) : (
            <div className="space-y-2">
            {filteredProjects.map((project) => (
              <ProjectSection
                key={project.id}
                project={project}
                sessions={getVisibleProjectSessions(project.id, filteredSessions, sessions)}
                expanded={normalizedQuery ? true : expandedProjectIds.has(project.id)}
                activeSessionId={activeSessionId}
                hoveredSession={hoveredSession}
                isSelectMode={isSelectMode}
                selectedIds={selectedIds}
                onToggleProject={handleProjectToggle}
                onNewSession={handleNewSession}
                onSessionClick={(session) => {
                  if (isSelectMode) {
                    toggleSelectSession(session.id);
                  } else {
                    handleSessionClick(session.id);
                  }
                }}
                onHoverSession={setHoveredSession}
                onDeleteSession={handleDeleteSession}
                onSessionContextMenu={handleSessionContextMenu}
                editingSessionId={editingSessionId}
                editingTitle={editingTitle}
                onEditingTitleChange={setEditingTitle}
                onCommitRename={commitRenamingSession}
                onCancelRename={cancelRenamingSession}
                t={t}
              />
            ))}
            </div>
          )}
        </div>
      </div>

      {isSelectMode ? (
        <div className="px-3 py-3 border-t border-border-muted">
          {showDeleteConfirm ? (
            <div className="border border-error/30 bg-error/10 rounded-lg px-3 py-3">
              <p className="text-[13px] text-text-primary mb-3">
                {t('sidebar.batchDeleteConfirm', { count: selectedIds.size })}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 px-3 py-1.5 rounded-lg text-[13px] font-medium text-text-secondary hover:bg-surface-hover transition-colors"
                >
                  {t('sidebar.cancel')}
                </button>
                <button
                  onClick={handleBatchDelete}
                  className="flex-1 px-3 py-1.5 rounded-lg text-[13px] font-medium bg-error text-white hover:bg-error/90 transition-colors"
                >
                  {t('sidebar.confirmDelete')}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <button
                  onClick={toggleSelectAll}
                  className="text-[12px] font-medium text-accent hover:text-accent/80 transition-colors"
                >
                  {allVisibleSelected ? t('sidebar.deselectAll') : t('sidebar.selectAll')}
                </button>
                <span className="text-[12px] text-text-muted">
                  {t('sidebar.nSelected', { count: selectedIds.size })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={exitSelectMode}
                  className="flex-1 px-3 py-2 rounded-xl text-[13px] font-medium text-text-secondary hover:bg-surface-hover transition-colors"
                >
                  {t('sidebar.cancel')}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={selectedIds.size === 0}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium bg-error text-white hover:bg-error/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t('common.delete')}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="px-3 py-3 border-t border-border-muted">
          <div className="flex items-center gap-2 rounded-2xl bg-background/50 px-3 py-2.5">
            <button
              onClick={() => { setShowSettings(false); setMainView('servers'); }}
              className={`w-8 h-8 rounded-xl flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0 ${mainView === 'servers' ? 'bg-surface-hover text-text-primary' : ''}`}
              title="服务器"
            >
              <Server className="w-4 h-4" />
            </button>
            <button
              onClick={() => { setMainView('chat'); setShowSettings(true); }}
              className="flex-1 min-w-0 flex items-center gap-2 text-left text-text-secondary hover:text-text-primary transition-colors"
            >
              <Settings className="w-4 h-4 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-text-primary">
                  {t('sidebar.settings')}
                </div>
                <div className="text-[11px] text-text-muted truncate">
                  {isConfigured ? t('sidebar.apiConfigured') : t('sidebar.apiNotConfigured')}
                </div>
              </div>
            </button>

            <UpdateBadge />

            <button
              onClick={toggleTheme}
              className="w-8 h-8 rounded-xl flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
              title={t('sidebar.themeToggle')}
            >
              {themeIcon}
            </button>
          </div>
        </div>
      )}

      {contextMenu && (
        <div
          className="fixed z-50 w-40 rounded-lg border border-border-muted bg-surface shadow-xl p-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            onClick={() => startRenamingSession(contextMenu.session)}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors"
          >
            <Pencil className="w-3.5 h-3.5" />
            <span>{t('sidebar.renameSession')}</span>
          </button>
          <button
            onClick={(event) => handleDeleteSession(event, contextMenu.session.id)}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[13px] text-error hover:bg-error/10 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{t('common.delete')}</span>
          </button>
        </div>
      )}
    </aside>
  );
}

type ProjectSectionProps = {
  project: ProjectSummary;
  sessions: Session[];
  expanded: boolean;
  activeSessionId: string | null;
  hoveredSession: string | null;
  isSelectMode: boolean;
  selectedIds: Set<string>;
  onToggleProject: (projectId: string) => void;
  onNewSession: (projectId: string) => void;
  onSessionClick: (session: Session) => void;
  onHoverSession: (sessionId: string | null) => void;
  onDeleteSession: (e: React.MouseEvent, sessionId: string) => void;
  onSessionContextMenu: (event: React.MouseEvent, session: Session) => void;
  editingSessionId: string | null;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  t: Translate;
};

function ProjectSection({
  project,
  sessions,
  expanded,
  activeSessionId,
  hoveredSession,
  isSelectMode,
  selectedIds,
  onToggleProject,
  onNewSession,
  onSessionClick,
  onHoverSession,
  onDeleteSession,
  onSessionContextMenu,
  editingSessionId,
  editingTitle,
  onEditingTitleChange,
  onCommitRename,
  onCancelRename,
  t,
}: ProjectSectionProps) {
  return (
    <section>
      <div className="group flex items-center gap-1">
        <button
          onClick={() => onToggleProject(project.id)}
          className="min-w-0 flex-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-text-secondary hover:text-text-primary hover:bg-surface-hover/60 transition-colors"
          title={project.cwd || project.name}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />
          )}
          <Folder className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="min-w-0 flex-1 text-[13px] font-medium truncate">{project.name}</span>
          {project.runningCount > 0 && (
            <span className="text-[10px] leading-4 px-1.5 rounded-full bg-accent-muted text-accent flex-shrink-0">
              {project.runningCount}
            </span>
          )}
        </button>
        <button
          onClick={() => onNewSession(project.id)}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted opacity-0 group-hover:opacity-100 hover:text-text-primary hover:bg-surface-hover transition-all"
          title={t('sidebar.newTask')}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {expanded && (
        <div className="mt-0.5 ml-7 space-y-0.5">
          {sessions.length === 0 ? (
            <div className="px-2 py-1 text-[12px] leading-5 text-text-muted">
              {t('sidebar.noTasks')}
            </div>
          ) : (
            sessions.map((session) => {
              const isActive = activeSessionId === session.id;
              const isSelected = selectedIds.has(session.id);
              const isEditing = editingSessionId === session.id;
              return (
                <div
                  key={session.id}
                  onClick={() => onSessionClick(session)}
                  onContextMenu={(event) => onSessionContextMenu(event, session)}
                  onMouseEnter={() => onHoverSession(session.id)}
                  onMouseLeave={() => onHoverSession(null)}
                  className={`group/session relative cursor-pointer rounded-lg px-2 py-1.5 transition-colors ${
                    isSelectMode && isSelected
                      ? 'bg-accent-muted/20'
                      : isActive && !isSelectMode
                        ? 'bg-surface-hover/90'
                        : 'hover:bg-surface-hover/60'
                  }`}
                >
                  <div className={`flex items-center gap-2 ${!isSelectMode ? 'pr-7' : ''}`}>
                    {isSelectMode && (
                      <div
                        className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-colors ${
                          isSelected
                            ? 'bg-accent text-white'
                            : 'border border-border-muted bg-background'
                        }`}
                      >
                        {isSelected && <Check className="w-2.5 h-2.5" />}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <input
                          autoFocus
                          value={editingTitle}
                          onChange={(event) => onEditingTitleChange(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onBlur={onCommitRename}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              event.currentTarget.blur();
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              onCancelRename();
                              event.currentTarget.blur();
                            }
                          }}
                          className="w-full rounded-md border border-accent/40 bg-background px-1.5 py-0.5 text-[13px] font-medium leading-5 text-text-primary outline-none"
                        />
                      ) : (
                        <div className="text-[13px] font-medium leading-5 text-text-primary truncate">
                          {session.title}
                        </div>
                      )}
                    </div>
                    <span className="text-[11px] leading-5 text-text-muted flex-shrink-0">
                      {formatSessionAge(session.updatedAt || session.createdAt, t)}
                    </span>
                  </div>

                  {!isSelectMode && hoveredSession === session.id && (
                    <button
                      onClick={(e) => onDeleteSession(e, session.id)}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-error hover:bg-surface-active transition-colors"
                      title={t('common.delete')}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}

function getVisibleProjectSessions(
  projectId: string,
  filteredSessions: Session[],
  allSessions: Session[]
): Session[] {
  const source = filteredSessions.length === allSessions.length ? allSessions : filteredSessions;
  return getProjectSessions(source, projectId).sort(
    (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
  );
}

function formatSessionAge(timestamp: number, t: Translate): string {
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < hour) {
    return t('sidebar.minutesAgo', { count: Math.max(1, Math.floor(diff / minute)) });
  }
  if (diff < day) {
    return t('sidebar.hoursAgo', { count: Math.max(1, Math.floor(diff / hour)) });
  }
  if (diff < 30 * day) {
    return t('sidebar.daysAgo', { count: Math.max(1, Math.floor(diff / day)) });
  }
  return t('sidebar.monthsAgo', { count: Math.max(1, Math.floor(diff / (30 * day))) });
}

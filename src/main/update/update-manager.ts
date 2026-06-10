import { shell, app } from 'electron';
import type { BrowserWindow } from 'electron';
import { log, logWarn, logError } from '../utils/logger';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
  downloadUrl: string | null;
  downloadProgress: null;
  error: string | null;
  dismissedVersion: string | null;
}

export type UpdateStateListener = (state: UpdateState) => void;

let updateState: UpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  latestVersion: null,
  releaseNotes: null,
  releaseUrl: null,
  downloadUrl: null,
  downloadProgress: null,
  error: null,
  dismissedVersion: null,
};

const listeners = new Set<UpdateStateListener>();

const MAX_RELEASE_NOTES_LENGTH = 2000;
const DEV_MOCK_UPDATE_VERSION = '9.9.9-dev';
const GITHUB_LATEST_RELEASE_API =
  'https://api.github.com/repos/SageFoundry/open-cowork/releases/latest';
const UPDATE_CHECK_TIMEOUT_MS = 15000;

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GitHubLatestRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubReleaseAsset[];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return typeof error === 'string' ? error : String(error);
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeVersion(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().replace(/^v/i, '');
  return trimmed || null;
}

function compareVersions(a: string, b: string): number {
  const normalizeParts = (value: string) =>
    normalizeVersion(value)
      ?.split(/[.-]/)
      .map((part) => {
        const numeric = Number.parseInt(part, 10);
        return Number.isFinite(numeric) ? numeric : 0;
      }) ?? [];

  const aParts = normalizeParts(a);
  const bParts = normalizeParts(b);
  const maxLength = Math.max(aParts.length, bParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const left = aParts[index] ?? 0;
    const right = bParts[index] ?? 0;
    if (left > right) {
      return 1;
    }
    if (left < right) {
      return -1;
    }
  }

  return 0;
}

function selectInstallerAsset(release: GitHubLatestRelease): GitHubReleaseAsset | null {
  const assets = release.assets ?? [];
  const candidates = assets.filter((asset) => {
    const name = asset.name?.toLowerCase() ?? '';
    return !!asset.browser_download_url && !name.endsWith('.yml') && !name.endsWith('.yaml');
  });

  return (
    candidates.find((asset) => {
      const name = asset.name?.toLowerCase() ?? '';
      return name.endsWith('.exe') && name.includes('win') && name.includes('x64');
    }) ??
    candidates.find((asset) => asset.name?.toLowerCase().endsWith('.exe')) ??
    candidates[0] ??
    null
  );
}

function sanitizeReleaseNotes(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const plain = stripHtml(value).replace(/https:\/\/private-user-images\.githubusercontent\.com\/\S+/gi, '[image]');
  if (!plain) {
    return null;
  }
  return plain.length > MAX_RELEASE_NOTES_LENGTH
    ? `${plain.slice(0, MAX_RELEASE_NOTES_LENGTH)}...`
    : plain;
}

export function sanitizeUpdateError(error: unknown): string {
  const raw = toErrorMessage(error);
  const statusMatch = raw.match(/\b([1-5]\d{2})\b/);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const lower = raw.toLowerCase();

  if (status === 504 || lower.includes('gateway time-out') || lower.includes('gateway timeout')) {
    return 'GitHub 发布信息暂时不可用（504 Gateway Timeout），请稍后重试，或打开发布页手动查看。';
  }
  if (status === 403 || lower.includes('rate limit')) {
    return 'GitHub 更新检查被限流或拒绝访问，请稍后重试。';
  }
  if (status === 404 || lower.includes('unable to find latest version')) {
    return '没有找到可用的 GitHub Release，请确认发布版本和 latest.yml 已上传。';
  }
  if (lower.includes('please check update first')) {
    return '自动下载状态还未准备好，请重新检查更新后再试。';
  }
  if (
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('connection') ||
    lower.includes('timeout')
  ) {
    return '检查更新时网络连接失败，请稍后重试。';
  }

  const withoutXml = raw
    .split(', XML:', 1)[0]
    .split('\n\n Data:', 1)[0]
    .replace(/https:\/\/private-user-images\.githubusercontent\.com\/\S+/gi, '[image]')
    .replace(/\s+/g, ' ')
    .trim();
  return withoutXml.length > 500 ? `${withoutXml.slice(0, 500)}...` : withoutXml || '检查更新失败。';
}

function notifyListeners() {
  for (const listener of listeners) {
    try {
      listener({ ...updateState });
    } catch (err) {
      logError('[UpdateManager] Listener error:', err);
    }
  }
}

function setState(updates: Partial<UpdateState>) {
  updateState = { ...updateState, ...updates };
  notifyListeners();
}

function getDevMockUpdateMode(): string | null {
  if (app.isPackaged) {
    return null;
  }
  const mode = process.env.OPEN_COWORK_MOCK_UPDATE?.trim().toLowerCase();
  return mode || null;
}

function applyDevMockUpdateState(mode: string): UpdateState | null {
  const latestVersion = process.env.OPEN_COWORK_MOCK_UPDATE_VERSION?.trim() || DEV_MOCK_UPDATE_VERSION;
  const releaseUrl = `https://github.com/SageFoundry/open-cowork/releases/tag/v${latestVersion}`;
  const downloadUrl =
    process.env.OPEN_COWORK_MOCK_UPDATE_DOWNLOAD_URL?.trim() ||
    `https://github.com/SageFoundry/open-cowork/releases/download/v${latestVersion}/Open-Cowork-${latestVersion}-win-x64.exe`;

  if (mode === 'available') {
    setState({
      status: 'available',
      latestVersion,
      releaseNotes: `Dev mock update for ${latestVersion}.`,
      releaseUrl,
      downloadUrl,
      downloadProgress: null,
      error: null,
    });
    return getUpdateState();
  }

  if (mode === 'downloaded') {
    setState({
      status: 'downloaded',
      latestVersion,
      releaseNotes: `Dev mock downloaded update for ${latestVersion}.`,
      releaseUrl,
      downloadUrl,
      downloadProgress: null,
      error: null,
    });
    return getUpdateState();
  }

  if (mode === 'not-available') {
    setState({
      status: 'not-available',
      latestVersion: updateState.currentVersion,
      releaseNotes: null,
      releaseUrl: null,
      downloadUrl: null,
      downloadProgress: null,
      error: null,
    });
    return getUpdateState();
  }

  if (mode === 'error') {
    setState({
      status: 'error',
      latestVersion: null,
      releaseNotes: null,
      releaseUrl: null,
      downloadUrl: null,
      downloadProgress: null,
      error: 'Dev mock update error.',
    });
    return getUpdateState();
  }

  logWarn('[UpdateManager] Unknown OPEN_COWORK_MOCK_UPDATE mode:', mode);
  return null;
}

async function fetchLatestGitHubRelease(): Promise<GitHubLatestRelease> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(GITHUB_LATEST_RELEASE_API, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `Open-Cowork/${app.getVersion()}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`GitHub Release API returned ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as GitHubLatestRelease;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkForUpdatesViaGitHubApi(): Promise<UpdateState> {
  log('[UpdateManager] Checking latest release via GitHub API...');
  const release = await fetchLatestGitHubRelease();
  const latestVersion = normalizeVersion(release.tag_name || release.name);

  if (!latestVersion || release.draft || release.prerelease) {
    throw new Error('GitHub latest release is missing a stable version.');
  }

  const releaseUrl =
    release.html_url || `https://github.com/SageFoundry/open-cowork/releases/tag/v${latestVersion}`;
  const installerAsset = selectInstallerAsset(release);
  const assetNames = release.assets?.map((asset) => asset.name).filter(Boolean) ?? [];
  log('[UpdateManager] GitHub API latest version:', latestVersion);
  log('[UpdateManager] GitHub API release assets:', assetNames.join(', ') || '(none)');
  log('[UpdateManager] GitHub API installer asset:', installerAsset?.name || '(none)');

  if (compareVersions(latestVersion, updateState.currentVersion) <= 0) {
    setState({
      status: 'not-available',
      latestVersion,
      releaseNotes: sanitizeReleaseNotes(release.body),
      releaseUrl,
      downloadUrl: null,
      downloadProgress: null,
      error: null,
    });
    return getUpdateState();
  }

  setState({
    status: 'available',
    latestVersion,
    releaseNotes: sanitizeReleaseNotes(release.body),
    releaseUrl,
    downloadUrl: installerAsset?.browser_download_url ?? null,
    downloadProgress: null,
    error: null,
  });
  return getUpdateState();
}

export function getUpdateState(): UpdateState {
  return { ...updateState };
}

export function subscribeUpdateState(listener: UpdateStateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function initUpdateManager(_getMainWindow: () => BrowserWindow | null) {
  log('[UpdateManager] Initialized');
}

export async function checkForUpdates(options: { silentOnError?: boolean } = {}): Promise<UpdateState> {
  try {
    log('[UpdateManager] Starting update check...');
    setState({ status: 'checking', error: null });

    const devMockMode = getDevMockUpdateMode();
    if (devMockMode) {
      log('[UpdateManager] Applying dev mock update state:', devMockMode);
      const mockState = applyDevMockUpdateState(devMockMode);
      if (mockState) {
        return mockState;
      }
    }

    return await checkForUpdatesViaGitHubApi();
  } catch (err: any) {
    const safeError = sanitizeUpdateError(err);
    logError('[UpdateManager] Check failed:', err);
    logError('[UpdateManager] Error stack:', err.stack);
    if (options.silentOnError) {
      setState({
        status: 'idle',
        error: null,
      });
      return getUpdateState();
    }
    setState({
      status: 'error',
      error: safeError,
    });
  }

  return getUpdateState();
}

export async function downloadUpdate(): Promise<void> {
  if (updateState.status !== 'available') {
    logWarn('[UpdateManager] No update available to download');
    return;
  }

  try {
    const targetUrl = updateState.downloadUrl || updateState.releaseUrl;
    if (!targetUrl) {
      const error = '没有找到可下载的安装包，请打开发布页手动查看。';
      setState({ status: 'error', error });
      throw new Error(error);
    }

    log('[UpdateManager] Opening update download URL:', targetUrl);
    await shell.openExternal(targetUrl);
    setState({ status: 'available', downloadProgress: null, error: null });
  } catch (err: any) {
    const safeError = sanitizeUpdateError(err);
    logError('[UpdateManager] Download failed:', err);
    setState({
      status: 'error',
      error: safeError,
    });
    throw err;
  }
}

export function installUpdate(): void {
  log('[UpdateManager] Install requested - opening release page as fallback');
  openReleasePage();
}

export function dismissUpdate(): void {
  if (updateState.latestVersion) {
    setState({ dismissedVersion: updateState.latestVersion, status: 'idle' });
    log('[UpdateManager] Dismissed update for version:', updateState.latestVersion);
  }
}

export function isUpdateDismissed(version: string): boolean {
  return updateState.dismissedVersion === version;
}

export function openReleasePage(): void {
  const url = updateState.releaseUrl || 'https://github.com/SageFoundry/open-cowork/releases/latest';
  shell.openExternal(url);
}

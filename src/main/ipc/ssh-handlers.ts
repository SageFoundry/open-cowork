import { ipcMain } from 'electron';
import type { SshService, SshServerInput, SshPermission, SshExecutionMode } from '../ssh/ssh-service';
import type { SshTerminalService } from '../ssh/ssh-terminal-service';

export function registerSshHandlers(getService: () => SshService | null, getTerminalService: () => SshTerminalService | null): void {
  const service = (): SshService => {
    const result = getService();
    if (!result) throw new Error('SSH 服务尚未初始化');
    return result;
  };
  ipcMain.handle('ssh.listServers', () => service().listServers());
  ipcMain.handle('ssh.listResourceTree', () => service().listResourceTree());
  ipcMain.handle('ssh.createFolder', (_event, name: string, parentId?: string) => service().createFolder(name, parentId));
  ipcMain.handle('ssh.moveResourceNode', (_event, nodeId: string, parentId: string) => service().moveResourceNode(nodeId, parentId));
  ipcMain.handle('ssh.saveServer', (_event, input: SshServerInput) => service().saveServer(input));
  ipcMain.handle('ssh.deleteServer', (_event, id: string) => service().deleteServer(id));
  ipcMain.handle('ssh.testConnection', (_event, id: string) => service().testConnection(id));
  ipcMain.handle('ssh.trustHostKey', (_event, id: string, fingerprint: string) => service().trustHostKey(id, fingerprint));
  ipcMain.handle('ssh.getConnectionStatus', (_event, id: string) => service().getConnectionStatus(id));
  ipcMain.handle('ssh.listConnectionStatuses', () => service().listConnectionStatuses());
  ipcMain.handle('ssh.disconnectServer', (_event, id: string) => service().disconnectServer(id));
  ipcMain.handle('ssh.listSessionGrants', (_event, sessionId: string) => service().listSessionGrants(sessionId));
  ipcMain.handle('ssh.listResourceGrants', (_event, sessionId: string) => service().listResourceGrants(sessionId));
  ipcMain.handle('ssh.grantResource', (_event, sessionId: string, nodeId: string, permission: SshPermission, recursive?: boolean, includeFutureChildren?: boolean, executionMode?: SshExecutionMode) => service().grantResource(sessionId, nodeId, permission, recursive, includeFutureChildren, executionMode));
  ipcMain.handle('ssh.revokeResource', (_event, sessionId: string, nodeId: string) => service().revokeResource(sessionId, nodeId));
  ipcMain.handle('ssh.denyAuthorization', (_event, sessionId: string) => service().denyAuthorization(sessionId));
  ipcMain.handle('ssh.grantSessionServer', (_event, sessionId: string, serverId: string, permission: SshPermission, executionMode?: SshExecutionMode) => service().grantSessionServer(sessionId, serverId, permission, executionMode));
  ipcMain.handle('ssh.revokeSessionServer', (_event, sessionId: string, serverId: string) => service().revokeSessionServer(sessionId, serverId));
  const terminals = (): SshTerminalService => {
    const result = getTerminalService();
    if (!result) throw new Error('SSH 终端服务尚未初始化');
    return result;
  };
  ipcMain.handle('ssh.cancelExecution', (_event, executionId: string) => service().cancelExecution(executionId));
  ipcMain.handle('ssh.openTerminal', (_event, serverId: string, cols?: number, rows?: number) => terminals().open(serverId, cols, rows));
  ipcMain.handle('ssh.writeTerminal', (_event, terminalId: string, text: string) => terminals().write(terminalId, text));
  ipcMain.handle('ssh.resizeTerminal', (_event, terminalId: string, cols: number, rows: number) => terminals().resize(terminalId, cols, rows));
  ipcMain.handle('ssh.closeTerminal', (_event, terminalId: string) => terminals().close(terminalId));
  ipcMain.handle('ssh.listAgentTerminals', (_event, sessionId: string) => service().listForegroundTerminals(sessionId));
  ipcMain.handle('ssh.openAgentTerminal', (_event, sessionId: string, serverId: string) => service().openForegroundTerminal(sessionId, serverId));
  ipcMain.handle('ssh.closeAgentTerminal', (_event, sessionId: string, terminalId: string) => service().closeForegroundTerminal(sessionId, terminalId));
}

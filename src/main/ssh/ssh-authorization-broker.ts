interface PendingAuthorization {
  resolvers: Array<() => void>;
  rejecters: Array<(error: Error) => void>;
}

export class SshAuthorizationBroker {
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(private readonly emitRequest: (sessionId: string) => void) {}

  request(sessionId: string): Promise<void> {
    let pending = this.pending.get(sessionId);
    if (!pending) {
      pending = { resolvers: [], rejecters: [] };
      this.pending.set(sessionId, pending);
      this.emitRequest(sessionId);
    }
    return new Promise<void>((resolve, reject) => {
      pending.resolvers.push(resolve);
      pending.rejecters.push(reject);
    });
  }

  approve(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    this.pending.delete(sessionId);
    pending.resolvers.forEach((resolve) => resolve());
  }

  deny(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    this.pending.delete(sessionId);
    const error = new Error('�û�δ��Ȩ SSH ��������Դ����ǰ�Ự');
    pending.rejecters.forEach((reject) => reject(error));
  }

  cancelSession(sessionId: string): void { this.deny(sessionId); }
}

import { connect, type Socket } from "node:net";
import { IpcRequestSchema, IpcResponseSchema, type IpcRequestT, type IpcResponseT } from "./schemas.js";

export interface IpcClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

export class IpcClient {
  private socket: Socket | null = null;
  private buf = "";
  private waiters: Map<string, (resp: IpcResponseT) => void> = new Map();

  constructor(private readonly opts: IpcClientOptions) {}

  async connect(): Promise<void> {
    if (this.socket) return;
    await new Promise<void>((resolve, reject) => {
      const sock = connect(this.opts.socketPath);
      sock.setEncoding("utf8");
      sock.once("connect", () => { this.socket = sock; this.attach(); resolve(); });
      sock.once("error", (err) => reject(err));
    });
  }

  private attach(): void {
    if (!this.socket) return;
    this.socket.on("data", (chunk: string) => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx); this.buf = this.buf.slice(idx + 1);
        if (!line.trim()) continue;
        let parsed;
        try { parsed = IpcResponseSchema.parse(JSON.parse(line)); }
        catch { continue; }
        const w = this.waiters.get(parsed.request_id);
        if (w) { this.waiters.delete(parsed.request_id); w(parsed); }
      }
    });
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<IpcResponseT> {
    if (!this.socket) await this.connect();
    const req: IpcRequestT = IpcRequestSchema.parse({
      request_id: crypto.randomUUID(),
      method,
      params,
    });
    const sock = this.socket!;
    return new Promise<IpcResponseT>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(req.request_id);
        reject(new Error("ipc request timeout: " + method));
      }, this.opts.timeoutMs ?? 5000);
      this.waiters.set(req.request_id, (resp) => { clearTimeout(timer); resolve(resp); });
      sock.write(JSON.stringify(req) + "\n");
    });
  }

  close(): void { this.socket?.end(); this.socket = null; }
}

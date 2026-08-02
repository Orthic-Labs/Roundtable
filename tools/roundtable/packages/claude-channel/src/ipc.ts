import { connect, type Socket } from "node:net";
import { IpcRequestSchema, IpcResponseSchema, type IpcRequestT, type IpcResponseT } from "./schemas.js";

export interface IpcClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

export class IpcClient {
  private socket: Socket | null = null;
  private buf = "";
  // Replies are correlated in arrival order, NOT by request_id: the node mints its own response
  // id and echoes nothing back (ipc.rs — `let request_id = Uuid::now_v7()`), and answers a parse
  // failure with the nil UUID. It also handles one request at a time per connection (the handler
  // is awaited before the next read), so arrival order is send order.
  private waiters: Array<(resp: IpcResponseT) => void> = [];

  constructor(private readonly opts: IpcClientOptions) {}

  async connect(): Promise<void> {
    if (this.socket) return;
    await new Promise<void>((resolve, reject) => {
      const sock = connect(this.opts.socketPath);
      sock.setEncoding("utf8");
      sock.once("connect", () => { this.socket = sock; this.attach(); resolve(); });
      sock.once("error", (err) => reject(err));
      // The node restarts on every reinstall/update; without this the dead socket stayed set,
      // every later request wrote into the void, and the whole channel was down until the MCP
      // process itself was restarted. Clearing it makes the next request() redial the pipe.
      sock.once("close", () => {
        if (this.socket !== sock) return;
        this.socket = null; this.buf = "";
        // Arrival-order correlation must not straddle a reconnect: a stale waiter would pair
        // with the first reply of the NEW connection. Everyone in flight loses their socket.
        this.waiters.splice(0).forEach((w) => w({ request_id: "", ok: false, payload: null, error: "ipc connection closed" }));
      });
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
        const w = this.waiters.shift();
        if (w) w(parsed);
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
    // The node deserializes the line straight into its internally-tagged IpcRequest enum, whose
    // fields sit ALONGSIDE `method` — not nested under `params`. Sending the envelope verbatim
    // made every request fail to parse ("bad request: missing field `code`"), which the node
    // answered with a nil-id error the old id-keyed correlation could never match, so each tool
    // hung until the 5s timeout. No test caught it: they all stub IpcClient.request.
    const wire = JSON.stringify({ method: req.method, ...req.params }) + "\n";
    return new Promise<IpcResponseT>((resolve, reject) => {
      // A timed-out request keeps its place in the queue as a tombstone rather than being removed:
      // the node still owes exactly one reply for it, and dropping the slot would pair that late
      // reply with the NEXT request's waiter, silently returning one call's answer to another.
      let live = true;
      const waiter = (resp: IpcResponseT) => { if (live) { live = false; clearTimeout(timer); resolve(resp); } };
      const timer = setTimeout(() => {
        if (!live) return;
        live = false;
        reject(new Error("ipc request timeout: " + method));
      }, this.opts.timeoutMs ?? 5000);
      this.waiters.push(waiter);
      sock.write(wire);
    });
  }

  close(): void { this.socket?.end(); this.socket = null; }
}

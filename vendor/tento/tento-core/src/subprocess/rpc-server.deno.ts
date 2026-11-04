export type Option<T> = T | null | undefined;

// Constants
const FOUR_KB = 4096 * 1024;
const MAX_FRAME_SIZE_BYTES = FOUR_KB;

// Default health check settings
const DEFAULT_HEALTH_CHECK_INTERVAL = 10; // seconds
const DEFAULT_HEALTH_CHECK_TIMEOUT = 5; // seconds

// Message types
enum MessageType {
  PING = 0,
  PONG = 1,
  RPC_REQUEST = 2,
  RPC_RESPONSE = 3,
}

// deno-lint-ignore no-explicit-any
type UntypedJsonObject = Record<string, any>;

// Handler function type
type HandlerFn<Params extends UntypedJsonObject = UntypedJsonObject> = (
  params: Params,
) => UntypedJsonObject | Promise<UntypedJsonObject>;
// deno-lint-ignore no-explicit-any
type HandlerTable = Map<string, HandlerFn<any>>;

// Every frame goes out whole and in order. Request handlers run concurrently
// with the read loop, so a pong (or the health loop's own ping) can be due
// while a response is half written, and `Deno.stdout.write` may accept fewer
// bytes than it was given. One queue of complete frames handles both.
let writeQueue: Promise<void> = Promise.resolve();

function writeFrame(...parts: Uint8Array[]): Promise<void> {
  const frame = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    frame.set(part, offset);
    offset += part.length;
  }
  const written = writeQueue.then(async () => {
    let done = 0;
    while (done < frame.length) {
      done += await Deno.stdout.write(frame.subarray(done));
    }
  });
  writeQueue = written.catch(() => {});
  return written;
}

// `Deno.stdin.read` returns what the pipe has, which for a large frame is
// less than the frame. Short only at EOF.
async function readExact(length: number): Promise<Uint8Array | null> {
  const buffer = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const n = await Deno.stdin.read(buffer.subarray(filled));
    if (n == null || n === 0) return null;
    filled += n;
  }
  return buffer;
}

// Base message interface
interface Message {
  type: MessageType;
  write(): Promise<void>;
}

// Ping message implementation
class PingMessage implements Message {
  type = MessageType.PING;

  static read(): PingMessage {
    return new PingMessage();
  }

  async write(): Promise<void> {
    await writeFrame(new Uint8Array([MessageType.PING]));
  }
}

// Pong message implementation
class PongMessage implements Message {
  type = MessageType.PONG;

  static read(): PongMessage {
    return new PongMessage();
  }

  async write(): Promise<void> {
    await writeFrame(new Uint8Array([MessageType.PONG]));
  }
}

// RPC request message implementation
class RpcRequestMessage implements Message {
  type = MessageType.RPC_REQUEST;

  constructor(
    public id: number,
    public method: string,
    public params: UntypedJsonObject,
  ) {}

  static async read(id: number): Promise<RpcRequestMessage> {
    // Read frame length
    const reqFrameLenBytes = await readExact(4);
    if (reqFrameLenBytes == null) {
      throw new Error("Failed to read request frame length");
    }

    const reqFrameLen = new DataView(reqFrameLenBytes.buffer).getUint32(
      0,
      false,
    );
    if (reqFrameLen > MAX_FRAME_SIZE_BYTES) {
      throw new Error(
        `Frame length ${reqFrameLen} exceeds maximum ${MAX_FRAME_SIZE_BYTES}`,
      );
    }

    // Read request body
    const reqBodyBytes = await readExact(reqFrameLen);
    if (reqBodyBytes == null) {
      throw new Error("Failed to read request body");
    }

    const reqBodyStr = new TextDecoder().decode(reqBodyBytes);
    const reqBody = JSON.parse(reqBodyStr);

    // Extract method and params
    const method = reqBody.method || "";
    const params = reqBody.params || {};

    // console.error(
    //   `[server] Received RPC request: method=${method}, params=${JSON.stringify(
    //     params
    //   )}`
    // );
    return new RpcRequestMessage(id, method, params);
  }

  async write(): Promise<void> {
    // Message type
    const messageTypeBytes = new Uint8Array([this.type]);

    // ID (8 bytes)
    const idBytes = new Uint8Array(8);
    new DataView(idBytes.buffer).setBigUint64(0, BigInt(this.id), false);

    // Body
    const body = { method: this.method, params: this.params };
    const bodyStr = JSON.stringify(body);
    const bodyBytes = new TextEncoder().encode(bodyStr);

    // Frame length (4 bytes)
    const frameLenBytes = new Uint8Array(4);
    new DataView(frameLenBytes.buffer).setUint32(0, bodyBytes.length, false);

    await writeFrame(messageTypeBytes, idBytes, frameLenBytes, bodyBytes);
  }
}

// RPC response message implementation
class RpcResponseMessage implements Message {
  type = MessageType.RPC_RESPONSE;

  constructor(
    public id: number,
    public response: UntypedJsonObject,
  ) {}

  static async read(id: number): Promise<RpcResponseMessage> {
    // Read frame length
    const respFrameLenBytes = await readExact(4);
    if (respFrameLenBytes == null) {
      throw new Error("Failed to read response frame length");
    }

    const respFrameLen = new DataView(respFrameLenBytes.buffer).getUint32(
      0,
      false,
    );
    if (respFrameLen > MAX_FRAME_SIZE_BYTES) {
      throw new Error(
        `Frame length ${respFrameLen} exceeds maximum ${MAX_FRAME_SIZE_BYTES}`,
      );
    }

    // Read response body
    const respBodyBytes = await readExact(respFrameLen);
    if (respBodyBytes == null) {
      throw new Error("Failed to read response body");
    }

    const respBodyStr = new TextDecoder().decode(respBodyBytes);
    const respBody = JSON.parse(respBodyStr);

    // console.error(
    //   `[server] Received RPC response: ${JSON.stringify(respBody)}`
    // );
    return new RpcResponseMessage(id, respBody);
  }

  async write(): Promise<void> {
    // console.error(
    //   `[server] Writing response: id=${this.id}, response=${JSON.stringify(
    //     this.response
    //   )}`
    // );

    // Message type
    const messageTypeBytes = new Uint8Array([this.type]);

    // ID (8 bytes)
    const idBytes = new Uint8Array(8);
    new DataView(idBytes.buffer).setBigUint64(0, BigInt(this.id), false);

    // Body
    const bodyStr = JSON.stringify(this.response);
    const bodyBytes = new TextEncoder().encode(bodyStr);

    // Frame length (4 bytes)
    const frameLenBytes = new Uint8Array(4);
    new DataView(frameLenBytes.buffer).setUint32(0, bodyBytes.length, false);

    await writeFrame(messageTypeBytes, idBytes, frameLenBytes, bodyBytes);
  }
}

// Read a message from stdin
async function readMessage(): Promise<Message | null> {
  try {
    // Read message type
    const messageTypeBytes = new Uint8Array(1);
    const readResult = await Deno.stdin.read(messageTypeBytes);
    if (readResult == null || readResult === 0) {
      // console.error("[server] EOF reached");
      return null;
    }

    const messageType = messageTypeBytes[0];
    // console.error(`[server] message type: ${messageType}`);

    switch (messageType) {
      case MessageType.PING:
        return PingMessage.read();

      case MessageType.PONG:
        return PongMessage.read();

      case MessageType.RPC_REQUEST: {
        // Read RPC ID
        const reqRpcIdBytes = await readExact(8);
        if (reqRpcIdBytes == null) {
          // console.error("[server] Failed to read RPC ID");
          return null;
        }

        const reqRpcId = Number(
          new DataView(reqRpcIdBytes.buffer).getBigUint64(0, false),
        );
        return await RpcRequestMessage.read(reqRpcId);
      }

      case MessageType.RPC_RESPONSE: {
        // Read RPC ID
        const respRpcIdBytes = await readExact(8);
        if (respRpcIdBytes == null) {
          // console.error("[server] Failed to read RPC ID");
          return null;
        }

        const respRpcId = Number(
          new DataView(respRpcIdBytes.buffer).getBigUint64(0, false),
        );
        return await RpcResponseMessage.read(respRpcId);
      }

      default:
        // console.error(`[server] Unknown message type: ${messageType}`);
        return null;
    }
  } catch (error) {
    if (error instanceof Deno.errors.BrokenPipe) {
      // console.error("[server] Broken pipe");
    } else if (error instanceof SyntaxError) {
      // console.error(`[server] JSON decode error: ${error.message}`);
    } else {
      // console.error(`[server] Unexpected error: ${String(error)}`);
    }
    return null;
  }
}

// RPC Server class
class RpcServer {
  private handlers: HandlerTable;
  private healthCheckInterval: number;
  private healthCheckTimeout: number;
  private lastPingTime: number;
  private lastMessageTime: number;
  private running: boolean;
  private healthCheckIntervalId?: Option<ReturnType<typeof setInterval>>;
  private dropHandler: () => Promise<void> = async () => {};
  private inFlight: Set<Promise<void>> = new Set();

  /**
   * Initialize an RPC server with optional handlers.
   *
   * @param handlers - A map of method names to handler functions
   * @param healthCheckInterval - Interval in seconds between health checks
   * @param healthCheckTimeout - Timeout in seconds for considering process unhealthy
   */
  constructor(
    handlers?: HandlerTable,
    healthCheckInterval: number = DEFAULT_HEALTH_CHECK_INTERVAL,
    healthCheckTimeout: number = DEFAULT_HEALTH_CHECK_TIMEOUT,
  ) {
    this.handlers = handlers || new Map();
    this.healthCheckInterval = healthCheckInterval;
    this.healthCheckTimeout = healthCheckTimeout;
    this.lastPingTime = Date.now();
    this.lastMessageTime = Date.now();
    this.running = false;
  }

  /**
   * Register a handler function for a specific method.
   *
   * @param method - The method name to handle
   * @param handler - The function to call when the method is invoked
   */
  registerHandler<Params extends UntypedJsonObject>(
    method: string,
    handler: HandlerFn<Params>,
  ): void {
    this.handlers.set(method, handler);
  }

  registerDropHandler(dropHandler: () => Promise<void>) {
    this.dropHandler = dropHandler;
  }

  /**
   * Handle a message received from the parent process.
   *
   * @param message - The received message
   * @returns True if the server should continue running, false otherwise
   */
  async handleMessage(message: Message | null): Promise<boolean> {
    // Update last message time regardless of message type
    this.lastMessageTime = Date.now();

    if (message == null) {
      return false;
    }

    if (message instanceof PingMessage) {
      // Send a pong in response to a ping
      // console.error("dbg/recv/ping");
      const pong = new PongMessage();
      await pong.write();
      // Record the ping time
      this.lastPingTime = Date.now();
    } else if (message instanceof PongMessage) {
      // Just record the pong
      // console.error("[server] Received pong from parent");
    } else if (message instanceof RpcRequestMessage) {
      // Not awaited: the loop has to keep reading (and answering pings) while
      // a long handler runs, or both sides' health checks take a busy server
      // for a dead one. A server whose handlers must not overlap serialises
      // them itself.
      const pending = this.dispatch(message);
      this.inFlight.add(pending);
      pending.finally(() => this.inFlight.delete(pending));
    }

    return true;
  }

  /** Requests whose handler has not answered yet. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  private async dispatch(message: RpcRequestMessage): Promise<void> {
    const handler = this.handlers.get(message.method);
    let result: UntypedJsonObject;
    if (handler) {
      try {
        result = await handler(message.params);
      } catch (error) {
        result = { error: String(error) };
      }
    } else {
      result = { error: `Method '${message.method}' not implemented` };
    }
    try {
      await new RpcResponseMessage(message.id, result).write();
    } catch (error) {
      // The parent is gone; the read loop sees EOF and shuts down.
      console.error(`[server] Failed to write response ${message.id}: ${error}`);
    }
  }

  /**
   * Continuously check the health of the connection to the parent process.
   * If no ping is received within the health check timeout, exit the process.
   */
  private healthCheckLoop(): void {
    // console.error("[server] Starting health check loop");
    if (this.healthCheckIntervalId != null) {
      clearInterval(this.healthCheckIntervalId);
      this.healthCheckIntervalId = null;
    }

    this.healthCheckIntervalId = setInterval(async () => {
      const currentTime = Date.now();
      const timeSinceLastMessage = (currentTime - this.lastMessageTime) / 1000;
      const timeSinceLastPing = (currentTime - this.lastPingTime) / 1000;

      // If we haven't received any message in a while, exit
      if (timeSinceLastMessage > this.healthCheckTimeout) {
        console.error(
          `[server] No messages received in ${timeSinceLastMessage.toFixed(
            1,
          )} seconds, exiting`,
        );
        // Exit with non-zero status to indicate error
        await this.dropHandler();
        Deno.exit(1);
      }

      // If we haven't received a ping in a specified interval, send one ourselves
      if (timeSinceLastPing > this.healthCheckInterval) {
        // console.error(
        //   `[server] Sending ping to parent, last message ${timeSinceLastMessage.toFixed(
        //     1
        //   )}s ago`
        // );
        try {
          const ping = new PingMessage();
          ping.write().catch(async (error) => {
            console.error(
              `[server] Failed to send ping to parent: ${error.message}, exiting`,
            );
            await this.dropHandler();
            Deno.exit(1);
          });
        } catch (error) {
          console.error(
            `[server] Failed to send ping to parent: ${String(error)}, exiting`,
          );
          await this.dropHandler();
          Deno.exit(1);
        }
      }
      // console.error("ping");
    }, 5_000);
  }

  /**
   * Start the RPC server and handle incoming messages.
   */
  async run(): Promise<void> {
    // console.error("[server] Starting RPC server");
    this.running = true;

    // Start the health check loop
    this.healthCheckLoop();

    // Handle SIGTERM gracefully
    Deno.addSignalListener("SIGTERM", async () => {
      console.error("[server] Received SIGTERM, shutting down");
      this.running = false;
      if (this.healthCheckIntervalId != null) {
        clearInterval(this.healthCheckIntervalId);
      }
      await this.dropHandler();
      Deno.exit(0);
    });

    try {
      while (this.running) {
        const message = await readMessage();
        if (!(await this.handleMessage(message))) {
          this.running = false;
          break;
        }
      }
    } catch (error) {
      console.error(
        `[server] Fatal error in main loop: ${error}, shutting down`,
      );
      this.running = false;
      await this.dropHandler();
      Deno.exit(1);
    } finally {
      console.error("[server] RPC server shutting down");
      if (this.healthCheckIntervalId != null) {
        clearInterval(this.healthCheckIntervalId);
      }
    }

    await this.dropHandler();
  }
}

export { RpcServer };

// Example calculator handler function
function calculatorAdd(params: { n: string; d: string }): UntypedJsonObject {
  try {
    const n = Number.parseInt(params.n);
    const d = Number.parseInt(params.d);
    return { value: n + d };
  } catch (error) {
    return { error: String(error) };
  }
}

// Direct execution entrypoint
if (import.meta.main) {
  // Example usage
  const server = new RpcServer();
  server.registerHandler("add", calculatorAdd);
  server.run();
}

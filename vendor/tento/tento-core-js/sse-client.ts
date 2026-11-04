// The core tsconfig compiles against ESNext plus types/globals.d.ts, not the
// DOM lib, so the streaming half of fetch is declared here, module-local and
// structural: just the members this client touches. Module scope shadows the
// global declarations for type-checking only; at runtime each name still
// resolves to the platform global (browser, Deno, workers).
declare function fetch(url: string, init: SseRequestInit): Promise<SseResponse>;

declare const AbortController: {
  new (): { readonly signal: SseAbortSignal; abort(): void };
};

declare const TextDecoder: {
  new (): { decode(input: Uint8Array, options: { stream: boolean }): string };
};

type SseAbortSignal = { readonly aborted: boolean };

type SseRequestInit = {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: SseAbortSignal;
};

type SseResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly body: Option<SseByteStream>;
};

type SseByteStream = {
  getReader(): {
    // `done` / `value` as loose as the platform reader reports them (a done
    // read may still name `value`), so a platform `fetch` fits `Transport`.
    read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
  };
};

export class SseClient {
  /**
   * POST `body` to `url` and stream the server-sent events back to
   * `callbacks`. `transport` is the `fetch` the request goes through (a
   * client's configured transport); `null` uses the global `fetch`, looked up
   * at send time.
   */
  static stream(
    url: string,
    body: unknown,
    callbacks: SseClient.Callbacks,
    extraHeaders?: Record<string, string>,
    transport: Option<SseClient.Transport> = null,
  ): SseClient.Connection {
    const controller = new AbortController();
    const send: SseClient.Transport = transport ?? ((u, init) => fetch(u, init));

    const run = async () => {
      try {
        const response = await send(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(extraHeaders ?? {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          callbacks.onError?.(new Error(`SSE request failed: ${response.status}`));
          return;
        }

        callbacks.onOpen?.();

        if (response.body == null) {
          callbacks.onError?.(new Error("SSE response has no body"));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done || value == null) break;

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop()!;

          for (const frame of frames) {
            if (!frame.trim()) continue;
            const event = SseClient.parseFrame(frame);
            if (event) callbacks.onEvent(event);
          }
        }

        if (buffer.trim()) {
          const event = SseClient.parseFrame(buffer);
          if (event) callbacks.onEvent(event);
        }

        callbacks.onClose?.();
      } catch (err) {
        if (controller.signal.aborted) return;
        callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    run();

    return {
      abort() {
        controller.abort();
      },
    };
  }

  private static parseFrame(frame: string): Option<SseClient.Event> {
    let event: Option<string> = null;
    let dataLines: string[] = [];

    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join("\n") };
  }
}

export namespace SseClient {
  /**
   * The `fetch` an SSE request goes through — structurally the part of the
   * platform `fetch` the stream reads (status, and the body's byte reader).
   */
  export type Transport = (url: string, init: SseRequestInit) => Promise<SseResponse>;

  export type Event = {
    event: Option<string>;
    data: string;
  };

  export type Callbacks = {
    onOpen?: () => void;
    onEvent: (event: Event) => void;
    onError?: (error: Error) => void;
    onClose?: () => void;
  };

  export type Connection = {
    abort(): void;
  };
}

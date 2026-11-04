import { Tracing } from "@tento-core/tracing";

export namespace client {
  let socket: Option<WebSocket>;
  export function connect(onNewLogLine: (logline: string) => void) {
    disconnect();

    const { location } = window;
    const wsUri = `wss://${location.host}/admin/logs/ws`;

    socket = new WebSocket(wsUri);
    socket.onopen = () => {
      Tracing.dev("Connected");
    };
    socket.onmessage = (ev) => {
      // Tracing.dev('Received: ' + ev.data, 'message')
      onNewLogLine(ev.data);
    };
    socket.onclose = () => {
      Tracing.dev("Disconnected");
      socket = null;
    };
  }

  function disconnect() {
    if (socket) {
      Tracing.dev("Disconnecting...");
      socket.close();
      socket = null;
    }
  }
}

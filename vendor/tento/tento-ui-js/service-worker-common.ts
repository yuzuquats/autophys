export namespace LonaServiceWorkerCommon {
  export type Message<Content> = {
    type: "debounce.flush" | "debounce.flush-cells" | "debounce.queue" | "version";
    content: Content;
  };
}

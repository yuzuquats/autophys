import { DateTime, Utc } from "@tento-chrono";

type SpanBase = {
  id: string;
  start: DateTime<Utc>;
  end: Option<DateTime<Utc>>;
  pointerEvents: Option<string>;
};

export type SpanContentBinder = (
  existing: Option<HTMLElement>,
) => HTMLElement;

export type Span = SpanBase & {
  bindContent: SpanContentBinder;
};

export namespace Span {
  export function staticContent($content: HTMLElement): SpanContentBinder {
    return () => $content;
  }
}

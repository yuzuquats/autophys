import { Storybook } from "@tento-ui/ui/storybook";
import { LogsList, SpanData, RenderConfig, SpanLineData } from "./logs-list";

/**
 * Example raw log format (different from SpanData).
 */
interface ExampleRawLog {
  ts: number;
  ok: boolean;
  ms: number;
  msg: string;
  count?: number;
}

/**
 * RenderConfig that converts ExampleRawLog to SpanData.
 */
const EXAMPLE_RENDER_CONFIG: RenderConfig<ExampleRawLog> = {
  emptyMessage: "No example logs found",
  toSpanData(raw: ExampleRawLog): SpanData {
    const date = new Date(raw.ts);
    const lines: SpanLineData[] = [];

    // Add message line
    lines.push({
      type: "message",
      level: raw.ok ? "info" : "error",
      text: raw.msg,
    });

    // Add count attribute if present
    if (raw.count !== undefined) {
      lines.push({
        type: "attribute",
        key: "count",
        value: String(raw.count),
      });
    }

    return {
      label: raw.ok ? "sync" : "sync_failed",
      timestamp: date.toISOString().replace("T", " ").slice(0, 19),
      duration: `${raw.ms}ms`,
      level: raw.ok ? "info" : "error",
      lines,
    };
  },
};

export class LogsListStoryBook extends Storybook.Default {
  title(): string {
    return "LogsList";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Empty State",
        render: () => {
          const $list = LogsList.make();
          $list.style.height = "120px";
          $list.bind({ logs: [] });
          return $list;
        },
      },
      {
        title: "Info Spans (Direct SpanData)",
        render: () => {
          const $list = LogsList.make();
          $list.style.height = "280px";
          $list.bind({
            logs: [
              {
                label: "weather_sync",
                timestamp: "2026-02-04 10:30:00",
                duration: "150ms",
                level: "info",
                lines: [
                  { type: "message", level: "info", text: "Sync completed successfully" },
                  { type: "attribute", key: "records", value: "42" },
                  { type: "attribute", key: "historical", value: "20 (2026-01-01 - 2026-01-31)" },
                  { type: "attribute", key: "forecast", value: "22 (2026-02-01 - 2026-02-28)" },
                ],
              },
              {
                label: "calendar_sync",
                timestamp: "2026-02-04 09:00:00",
                duration: "87ms",
                level: "info",
                lines: [
                  { type: "message", level: "info", text: "Calendar events fetched" },
                  { type: "attribute", key: "events", value: "15" },
                ],
              },
            ],
          });
          return $list;
        },
      },
      {
        title: "Error Span",
        render: () => {
          const $list = LogsList.make();
          $list.style.height = "150px";
          $list.bind({
            logs: [
              {
                label: "api_request",
                timestamp: "2026-02-04 08:45:00",
                duration: "2340ms",
                level: "error",
                lines: [
                  { type: "message", level: "error", text: "Connection timeout: API server unreachable" },
                  { type: "attribute", key: "endpoint", value: "/api/v1/weather" },
                  { type: "attribute", key: "retries", value: "3" },
                ],
              },
            ],
          });
          return $list;
        },
      },
      {
        title: "All Log Levels",
        render: () => {
          const $list = LogsList.make();
          $list.style.height = "400px";
          $list.bind({
            logs: [
              {
                label: "trace_example",
                timestamp: "2026-02-04 12:00:00",
                level: "trace",
                lines: [
                  { type: "message", level: "trace", text: "Entering function process_data" },
                ],
              },
              {
                label: "debug_example",
                timestamp: "2026-02-04 12:00:01",
                level: "debug",
                lines: [
                  { type: "message", level: "debug", text: "Cache miss for key user:123" },
                  { type: "attribute", key: "cache_size", value: "1024" },
                ],
              },
              {
                label: "info_example",
                timestamp: "2026-02-04 12:00:02",
                duration: "45ms",
                level: "info",
                lines: [
                  { type: "message", level: "info", text: "Request processed successfully" },
                ],
              },
              {
                label: "warn_example",
                timestamp: "2026-02-04 12:00:03",
                level: "warn",
                lines: [
                  { type: "message", level: "warn", text: "Rate limit approaching threshold" },
                  { type: "attribute", key: "current", value: "950" },
                  { type: "attribute", key: "limit", value: "1000" },
                ],
              },
              {
                label: "error_example",
                timestamp: "2026-02-04 12:00:04",
                duration: "1234ms",
                level: "error",
                lines: [
                  { type: "message", level: "error", text: "Database connection failed" },
                  { type: "attribute", key: "host", value: "db.example.com" },
                  { type: "attribute", key: "port", value: "5432" },
                ],
              },
            ],
          });
          return $list;
        },
      },
      {
        title: "With RenderConfig (Raw Logs)",
        render: () => {
          const $list = LogsList.make() as LogsList<ExampleRawLog>;
          $list.style.height = "260px";
          $list.bind({
            renderConfig: EXAMPLE_RENDER_CONFIG,
            logs: [
              {
                ts: Date.now() - 60000,
                ok: true,
                ms: 234,
                msg: "Synced successfully",
                count: 15,
              },
              {
                ts: Date.now() - 120000,
                ok: false,
                ms: 3500,
                msg: "Network error: connection refused",
              },
              {
                ts: Date.now() - 180000,
                ok: true,
                ms: 178,
                msg: "Partial sync completed",
                count: 8,
              },
            ],
          });
          return $list;
        },
      },
    ];
  }
}

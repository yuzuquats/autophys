import { Storybook } from "@tento-ui/ui/storybook";
import { SpanLine } from "./span-line";

export class SpanLineStoryBook extends Storybook.Default {
  title(): string {
    return "SpanLine";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Header (info)",
        render: () => {
          const $line = SpanLine.makeWith({
            type: "header",
            level: "info",
            label: "http_request",
            timestamp: "2026-02-06 12:00:00",
            duration: "150ms",
          });
          $line.assignStyles({ width: "100%", maxWidth: "400px" });
          return $line;
        },
      },
      {
        title: "Header (error)",
        render: () => {
          const $line = SpanLine.makeWith({
            type: "header",
            level: "error",
            label: "db_query_failed",
            timestamp: "2026-02-06 12:00:00",
            duration: "2340ms",
          });
          $line.assignStyles({ width: "100%", maxWidth: "400px" });
          return $line;
        },
      },
      {
        title: "Header (warn)",
        render: () => {
          const $line = SpanLine.makeWith({
            type: "header",
            level: "warn",
            label: "rate_limit",
            timestamp: "2026-02-06 12:00:00",
          });
          $line.assignStyles({ width: "100%", maxWidth: "400px" });
          return $line;
        },
      },
      {
        title: "Header (debug)",
        render: () => {
          const $line = SpanLine.makeWith({
            type: "header",
            level: "debug",
            label: "cache_lookup",
            timestamp: "2026-02-06 12:00:00",
            duration: "2ms",
          });
          $line.assignStyles({ width: "100%", maxWidth: "400px" });
          return $line;
        },
      },
      {
        title: "Header (trace)",
        render: () => {
          const $line = SpanLine.makeWith({
            type: "header",
            level: "trace",
            label: "entering_function",
            timestamp: "2026-02-06 12:00:00",
          });
          $line.assignStyles({ width: "100%", maxWidth: "400px" });
          return $line;
        },
      },
      {
        title: "Message (info)",
        render: () => {
          const $line = SpanLine.makeWith({
            type: "message",
            level: "info",
            text: "Request processed successfully",
          });
          $line.assignStyles({ width: "100%", maxWidth: "400px" });
          return $line;
        },
      },
      {
        title: "Message (error)",
        render: () => {
          const $line = SpanLine.makeWith({
            type: "message",
            level: "error",
            text: "Database connection failed",
          });
          $line.assignStyles({ width: "100%", maxWidth: "400px" });
          return $line;
        },
      },
      {
        title: "Attribute",
        render: () => {
          const $line = SpanLine.makeWith({
            type: "attribute",
            key: "user_id",
            value: "12345",
          });
          $line.assignStyles({ width: "100%", maxWidth: "400px" });
          return $line;
        },
      },
    ];
  }
}

import { Storybook } from "@tento-ui/ui/storybook";
import { SpanRow } from "./span-row";
import { Local } from "@tento-chrono";
import { Column } from "@tento-ui/component-builtin";

export class SpanRowStoryBook extends Storybook.Default {
  title(): string {
    return "SpanRow";
  }

  examples(): Storybook.Example[] {
    const now = Local.now().rfc3339();

    return [
      {
        title: "HTTP Request (200)",
        render: () => {
          const $row = SpanRow.make();
          $row.bind({
            id: 1,
            timestamp: now,
            sessionId: "session-1",
            meta: {
              parentId: null,
              name: "HTTP request",
              file: null,
              modulePath: null,
              target: "actix_web",
              line: null,
              level: "INFO",
            },
            initialAttributes: {
              "http.client_ip": "192.168.1.100",
              "http.method": "GET",
              "http.route": "/api/users",
            },
            records: [{ "http.status_code": "200" }],
            elapsedTime: 45,
          });
          $row.assignStyles({ width: "100%", maxWidth: "400px" });
          return $row;
        },
      },
      {
        title: "HTTP Request (500)",
        render: () => {
          const $row = SpanRow.make();
          $row.bind({
            id: 2,
            timestamp: now,
            sessionId: "session-1",
            meta: {
              parentId: null,
              name: "HTTP request",
              file: null,
              modulePath: null,
              target: "actix_web",
              line: null,
              level: "ERROR",
            },
            initialAttributes: {
              "http.client_ip": "10.0.0.1",
              "http.method": "POST",
              "http.route": "/api/data",
            },
            records: [{ "http.status_code": "500" }],
            elapsedTime: 1234,
          });
          $row.assignStyles({ width: "100%", maxWidth: "400px" });
          return $row;
        },
      },
      {
        title: "Custom Span",
        render: () => {
          const $row = SpanRow.make();
          $row.bind({
            id: 3,
            timestamp: now,
            sessionId: "session-1",
            meta: {
              parentId: null,
              name: "database_query",
              file: "src/db.rs",
              modulePath: "app::db",
              target: "app::db",
              line: 42,
              level: "DEBUG",
            },
            initialAttributes: {
              query: "SELECT * FROM users",
            },
            records: [],
            elapsedTime: 12,
          });
          $row.assignStyles({ width: "100%", maxWidth: "400px" });
          return $row;
        },
      },
      {
        title: "All Log Levels",
        render: () => {
          const $col = Column.make();
          $col.assignStyles({ gap: "4px", width: "100%", maxWidth: "400px" });

          const levels = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];
          for (const level of levels) {
            const $row = SpanRow.make();
            $row.bind({
              id: levels.indexOf(level),
              timestamp: now,
              sessionId: "session-1",
              meta: {
                parentId: null,
                name: `${level.toLowerCase()}_span`,
                file: null,
                modulePath: null,
                target: "app",
                line: null,
                level,
              },
              initialAttributes: {},
              records: [],
              elapsedTime: null,
            });
            $row.assignStyles({ width: "100%" });
            $col.appendChild($row);
          }

          return $col;
        },
      },
      {
        title: "HTTP Status Codes",
        render: () => {
          const $col = Column.make();
          $col.assignStyles({ gap: "4px", width: "100%", maxWidth: "400px" });

          const statuses = [
            { code: "200", method: "GET", route: "/api/health" },
            { code: "201", method: "POST", route: "/api/users" },
            { code: "301", method: "GET", route: "/old-path" },
            { code: "404", method: "GET", route: "/not-found" },
            { code: "500", method: "POST", route: "/api/crash" },
          ];

          for (let i = 0; i < statuses.length; i++) {
            const status = statuses[i];
            const $row = SpanRow.make();
            $row.bind({
              id: i,
              timestamp: now,
              sessionId: "session-1",
              meta: {
                parentId: null,
                name: "HTTP request",
                file: null,
                modulePath: null,
                target: "actix_web",
                line: null,
                level: status.code.startsWith("5") ? "ERROR" : "INFO",
              },
              initialAttributes: {
                "http.client_ip": "127.0.0.1",
                "http.method": status.method,
                "http.route": status.route,
              },
              records: [{ "http.status_code": status.code }],
              elapsedTime: Math.floor(Math.random() * 500),
            });
            $row.assignStyles({ width: "100%" });
            $col.appendChild($row);
          }

          return $col;
        },
      },
    ];
  }
}

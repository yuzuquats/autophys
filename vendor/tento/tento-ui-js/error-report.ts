// import { Log } from "./log";
// import { Session } from "./session";

// export namespace ErrorReport {
//   let shouldReportErrorFilter: (source: Option<URL>) => boolean = () => true;

//   export function setFilter(
//     shouldReportError: (source: Option<URL>) => boolean
//   ) {
//     shouldReportErrorFilter = shouldReportError;
//   }

//   function reportError(
//     cause: Option<string>,
//     name: Option<string>,
//     message: Option<string>,
//     stack: Option<string>
//   ) {
//     const params = new URLSearchParams(location.search);
//     fetch("/api/errors", {
//       headers: {
//         "Content-Type": "application/json",
//       },
//       method: "POST",
//       body: JSON.stringify({
//         cause,
//         name,
//         message,
//         sessionDurationMs: new Date().getTime() - Log.getStartMs(),
//         stack,
//         uri: location.origin + location.pathname,
//         sessionId: Session.id,
//       }),
//     });
//   }

//   window.onerror = (message, source, lineno, colno, error) => {
//     if (!shouldReportErrorFilter(source ? new URL(source) : null)) {
//       return;
//     }

//     if (!error) {
//       return;
//     }

//     reportError(String(error.cause), error.name, error.message, error.stack);
//   };

//   window.onunhandledrejection = (e: PromiseRejectionEvent) => {
//     reportError(null, null, null, String(e.reason.stack));
//     return true;
//   };
// }

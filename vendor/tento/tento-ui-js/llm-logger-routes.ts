import { DateTime, NaiveDate, Utc } from "@tento-chrono";
import { Rational as _Rational } from "@tento-core/rational";
import { Uuid } from "@tento-core/uuid";

export namespace Network {
  export interface BatchEntriesRequest {
    entries: UntypedJson[];
    sessionId: string;
  }
  export interface AbandonRequest {
    sessionId: string;
  }
  export type SessionResult = "success" | "failure";
  export interface CompleteRequest {
    feedback?: Option<string>;
    result: SessionResult;
    sessionId: string;
  }
  export interface PendingCountResponse {
    count: number;
  }
  export interface SessionParam {
    label: string;
    stepIndex: number;
    value: string;
  }
  export type SessionStatus = "pending" | "in_progress" | "completed" | "abandoned";
  export interface StepRequest {
    checked: boolean;
    sessionId: string;
    stepIndex: number;
    stepText: string;
  }
  export interface Session {
    completedSteps?: number[];
    createdAt: DateTime<Utc>;
    displayParams?: Option<SessionParam[]>;
    flaky?: Option<string>;
    id: string;
    instructions: string[];
    metadata?: Option<UntypedJson>;
    prefix: string;
    status: SessionStatus;
    tracingUuid?: Option<Uuid>;
  }
  export namespace Session {
    export function parse(raw: UntypedJson): Session {
      raw.createdAt && (raw.createdAt = Utc.parse(raw.createdAt));
      raw.tracingUuid && (raw.tracingUuid = Uuid.parse(raw.tracingUuid));
      return raw;
    }
  }
  export interface SessionCompletion {
    feedback?: Option<string>;
    result: SessionResult;
  }
  export namespace SessionCompletion {
    export function parse(raw: UntypedJson): SessionCompletion {
      return raw;
    }
  }
  export interface SessionListEntry extends Session {
    completion?: Option<SessionCompletion>;
  }
  export namespace SessionListEntry {
    export function parse(raw: UntypedJson): SessionListEntry {
      raw = Session.parse(raw);
      raw.completion && (raw.completion = SessionCompletion.parse(raw.completion));
      return raw;
    }
  }
  export type Routes = {
    "/_/ux-test/abandon": {
      post: {
        config: {
          body: AbandonRequest
        }
      }
    }
    "/_/ux-test/complete": {
      post: {
        config: {
          body: CompleteRequest
        }
      }
    }
    "/_/ux-test/logs": {
      post: {
        config: {
          body: BatchEntriesRequest
        }
      }
    }
    "/_/ux-test/step": {
      post: {
        config: {
          body: StepRequest
        }
      }
    }
    "/_/ux-test/pending": {
      get: {
        response?: Option<Session>
      }
    }
    "/_/ux-test/pending-count": {
      get: {
        response: PendingCountResponse
      }
    }
    "/_/ux-test/pending-flaky": {
      get: {
        response: Session[]
      }
    }
    "/_/ux-test/session/{session_id}": {
      get: {
        config: {
          path: {
            session_id: string
          }
        }
        response?: Option<Session>
      }
    }
    "/_/ux-test/sessions": {
      get: {
        response: SessionListEntry[]
      }
    }
    "/_/ux-test/sessions/{session_id}": {
      delete: {
        config: {
          path: {
            session_id: string
          }
        }
      }
    }
    "/_/ux-test/sessions/{session_id}/logs": {
      get: {
        config: {
          path: {
            session_id: string
          }
        }
      }
    }
  };
  export const REVIVERS = {
    "/_/ux-test/pending": {
      parse: {
        get: Session.parse,
      },
    },
    "/_/ux-test/pending-count": {
      parse: {
      },
    },
    "/_/ux-test/pending-flaky": {
      parse: {
        get: (p: UntypedJson[]) => p.map(Session.parse),
      },
    },
    "/_/ux-test/session/{session_id}": {
      parse: {
        get: Session.parse,
      },
    },
    "/_/ux-test/sessions": {
      parse: {
        get: (p: UntypedJson[]) => p.map(SessionListEntry.parse),
      },
    },
  };
}

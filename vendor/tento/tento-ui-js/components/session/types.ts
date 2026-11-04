import type { SessionHeader } from "./session-header";

/** Compatibility aliases; new callers use the `SessionHeader` namespace. */
export type SessionState = SessionHeader.State;
export type SessionStatus = SessionHeader.Status;
export type SessionHeaderProps = SessionHeader.Props;

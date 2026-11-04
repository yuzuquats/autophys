/** Which controls a gated-capability settings panel offers, given what the
 * server said and what the operator has typed.
 *
 * A "gate" is a capability an app refuses to run until a boundary check
 * passes — the torrent daemon's downloads behind a verified VPN exit is the
 * first one. Every such panel has the same five verbs and the same trap: the
 * verbs are *not* independent. Enabling is only meaningful against settings
 * the server already holds, so it must be off while the form is dirty; saving
 * is only meaningful while the capability is stopped, because saving under a
 * running engine would swap the boundary out from under it.
 *
 * The original torrent panel expressed this as five `||=` statements that ran
 * immediately after a loop had assigned every button's `disabled`. It was
 * correct, and it was correct only because of that ordering — nothing in the
 * expressions said so, and a sixth verb added below them would have silently
 * defaulted to enabled. Stating it as a total function over a model instead
 * makes the couplings visible, testable without a DOM, and identical in every
 * app that grows a gate. */
export namespace ConnectionGate {
  /** What the panel knows. Every field is what it says: no `undefined`
   * standing in for "the server has not answered yet" — that is `loaded`. */
  export interface Model {
    /** A request is in flight. Nothing is actionable while it is. */
    busy: boolean;
    /** The server has answered at least once. */
    loaded: boolean;
    /** The capability is running right now. */
    active: boolean;
    /** The operator asked for it to run; it may still be stopped. */
    enabled: boolean;
    /** Settings exist to enable against. */
    configured: boolean;
    /** The form differs from what the server holds. */
    dirty: boolean;
    /** The server accepts writes. A host-level override (the legacy
     * `--vpn-exit-ip` flag) makes the whole panel read-only. */
    editable: boolean;
  }

  /** `true` means the control is offered. */
  export interface Controls {
    fields: boolean;
    test: boolean;
    save: boolean;
    enable: boolean;
    disable: boolean;
    refresh: boolean;
  }

  /** The one-line reason a control is withheld, for the panel's status text
   * and for a test to assert against something other than a boolean. */
  export type Reason =
    | "busy"
    | "loading"
    | "read-only"
    | "running"
    | "unsaved"
    | "unconfigured"
    | "already-stopped"
    | null;

  export function controls(model: Model): Controls {
    const settled = !model.busy && model.loaded;
    return {
      // Editing under a running engine would let the operator change the
      // boundary the engine is already using.
      fields: settled && model.editable && !model.active,
      // Testing is read-only and never touches the engine, so it stays
      // available whenever the panel is settled and writable.
      test: settled && model.editable,
      save: settled && model.editable && !model.active && model.dirty,
      // Enable verifies what the SERVER holds. Offering it against unsaved
      // edits would verify one thing and start another.
      enable:
        settled &&
        model.editable &&
        !model.active &&
        !model.dirty &&
        model.configured,
      // Stopping stays available whenever there is something to stop —
      // including under a host override, where it is the only kill switch
      // the operator has without restarting the daemon.
      disable: settled && (model.active || model.enabled),
      refresh: settled && model.editable,
    };
  }

  /** Why `enable` is withheld — the control operators ask about most. */
  export function enableReason(model: Model): Reason {
    if (model.busy) return "busy";
    if (!model.loaded) return "loading";
    if (!model.editable) return "read-only";
    if (model.active) return "running";
    if (model.dirty) return "unsaved";
    if (!model.configured) return "unconfigured";
    return null;
  }

  /** Why `disable` is withheld. */
  export function disableReason(model: Model): Reason {
    if (model.busy) return "busy";
    if (!model.loaded) return "loading";
    if (!model.active && !model.enabled) return "already-stopped";
    return null;
  }

  /** A fresh panel: nothing known, nothing offered. */
  export const UNLOADED: Model = {
    busy: false,
    loaded: false,
    active: false,
    enabled: false,
    configured: false,
    dirty: false,
    editable: true,
  };
}

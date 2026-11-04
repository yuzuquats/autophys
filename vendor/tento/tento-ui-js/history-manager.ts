import { Tracing } from "@tento-trace/tracing";

/** The key of the entry's position in `history.state`, on every entry this manager writes. */
const INDEX_KEY = "historyIndex";

/** `state`'s position, when an entry this manager wrote carries one. */
function indexOf(state: unknown): Option<number> {
  if (state == null || typeof state !== "object") return null;
  const index: unknown = Reflect.get(state, INDEX_KEY);
  return typeof index === "number" ? index : null;
}

/** The state for an entry at `index` (none when the position is unknown). */
function stamp(index: Option<number>): Option<Record<string, number>> {
  return index == null ? null : { [INDEX_KEY]: index };
}

/**
 * `state` (the entry's current `history.state`) with the position at `index`
 * merged in. Keys another script stored on the entry stay (`initialize`
 * does not replace the whole state with the stamp). A non-object
 * state has nothing to keep; with no position, the state is kept as it is.
 */
function stampOver(state: unknown, index: Option<number>): unknown {
  const own = state != null && typeof state === "object" && !Array.isArray(state)
    ? { ...(state as Record<string, unknown>) }
    : null;
  if (index == null) return own ?? state;
  return { ...(own ?? {}), [INDEX_KEY]: index };
}

class HistoryManagerImpl {
  private currentModal: Option<HistoryManager.ModalState> = null;
  private initialized = false;
  private modalRegistrations = new Map<string, HistoryManager.ModalHandlers>();
  private baseUrlChangeHandler: Option<(pathname: string) => Promise<void> | void> = null;
  // Depth counter (not a boolean): overlapping popstates must keep the
  // guard up until the *last* handler settles.
  private popStateDepth = 0;
  /**
   * The current entry's position in the session history, when known: every
   * entry this manager writes carries it (`INDEX_KEY`). Null after a popstate
   * onto an entry without one (another script's, or one written before
   * entries carried it) until the next popstate onto one that has it.
   */
  private index: Option<number> = null;
  /** How many entries the last popstate moved (forward > 0); 0 when unknown. */
  private lastMove = 0;

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    this.index = indexOf(window.history.state) ?? 0;
    window.history.replaceState(stampOver(window.history.state, this.index), "");

    window.addEventListener("popstate", this.handlePopState.bind(this));

    const handlers = this.modalRegistrations.get(window.location.pathname);
    if (handlers) {
      this.setModal(window.location.pathname, "/", handlers);
    }
  }

  registerModal(url: string, handlers: HistoryManager.ModalHandlers): void {
    this.modalRegistrations.set(url, handlers);
  }

  onBaseUrlChange(handler: (pathname: string) => Promise<void> | void): void {
    this.baseUrlChangeHandler = handler;
  }

  async pushBase(url: string): Promise<void> {
    if (this.currentModal) {
      this.updateBaseUrl(url);
      return;
    }

    // Skip if we're handling a popstate event (prevents infinite loop)
    if (this.popStateDepth > 0) {
      Tracing.log("nav/url-suppressed", { url });
      return;
    }

    // Compare path + query so query-addressed urls (e.g. `/sheet?t=...`)
    // are idempotent and pushes onto a query-bearing location replace it.
    const current = window.location.pathname + window.location.search;
    if (current !== url) {
      Tracing.log("nav/url", { url, from: current });
      this.index = this.index == null ? null : this.index + 1;
      window.history.pushState(stamp(this.index), "", url);
    }
  }

  replaceBase(url: string): void {
    if (this.currentModal) {
      this.updateBaseUrl(url);
      return;
    }

    const current = window.location.pathname + window.location.search;
    if (current !== url) {
      Tracing.log("nav/url-replace", { url, from: current });
      window.history.replaceState(stampOver(window.history.state, this.index), "", url);
    }
  }

  /**
   * Put the base URL back on `url`, the route of what is on screen, after a
   * navigation that failed before it published (lona's failed sheet open).
   * Inside a popstate that moved forward onto the failed route, step back to
   * the entry it came from, which holds `url`: a replace would leave two
   * entries for `url` in a row, and Back would land on it once more. In every
   * other case (a move back onto it, a modal, no popstate, a move this
   * manager cannot measure) replace the failed route in place, so a dead
   * route does not stay behind. That includes an open that fails only after
   * the popstate handler has settled (`popStateDepth` back at 0): the move is
   * no longer known, so this is the replace, the safe fallback that can leave
   * the previous route's entry twice in a row, not the step back.
   */
  restoreBase(url: string): void {
    const move = this.popStateDepth > 0 && !this.currentModal ? this.lastMove : 0;
    if (move > 0) {
      Tracing.log("nav/url-restore-back", { url, move });
      window.history.go(-move);
      return;
    }
    this.replaceBase(url);
  }

  private updateBaseUrl(newBaseUrl: string): void {
    if (!this.currentModal || this.currentModal.dismissing) return;
    if (this.currentModal.baseUrl === newBaseUrl) return;

    this.currentModal.baseUrl = newBaseUrl;
  }

  async pushModal(url: string): Promise<void> {
    const handlers = this.modalRegistrations.get(url);
    if (!handlers) {
      console.warn(`HistoryManager: No modal registered for URL: ${url}`);
      return;
    }

    if (this.currentModal?.url === url && !this.currentModal.dismissing) {
      return;
    }

    if (this.currentModal && this.currentModal.url !== url) {
      const baseUrl = this.currentModal.baseUrl;
      await this.dismissInternal();
      window.history.replaceState(stampOver(window.history.state, this.index), "", url);
      this.setModal(url, baseUrl, handlers);
      return;
    }

    const baseUrl = window.location.pathname;
    if (baseUrl !== url) {
      this.index = this.index == null ? null : this.index + 1;
      window.history.pushState(stamp(this.index), "", url);
    }
    this.setModal(url, baseUrl, handlers);
  }

  async dismissModal(): Promise<void> {
    if (!this.currentModal || this.currentModal.dismissing) return;

    const { url, baseUrl } = this.currentModal;
    await this.dismissInternal();

    if (window.location.pathname === url) {
      window.history.replaceState(stampOver(window.history.state, this.index), "", baseUrl);
    }

    this.currentModal = undefined;
  }

  isModalActive(url?: string): boolean {
    if (!this.currentModal) return false;
    if (url)
      return this.currentModal.url === url && !this.currentModal.dismissing;
    return !this.currentModal.dismissing;
  }

  private setModal(
    url: string,
    baseUrl: string,
    handlers: HistoryManager.ModalHandlers,
  ): void {
    this.currentModal = { url, baseUrl, handlers, dismissing: false };
    handlers.reveal();
  }

  private async dismissInternal(): Promise<void> {
    if (!this.currentModal || this.currentModal.dismissing) return;
    this.currentModal.dismissing = true;
    await this.currentModal.handlers.dismiss();
  }

  private async handlePopState(): Promise<void> {
    const newPath = window.location.pathname;
    const index = indexOf(window.history.state);
    this.lastMove = index != null && this.index != null ? index - this.index : 0;
    this.index = index;

    if (this.currentModal && newPath !== this.currentModal.url) {
      await this.dismissInternal();
      this.currentModal = undefined;
    }

    const handlers = this.modalRegistrations.get(newPath);
    if (handlers && !this.currentModal) {
      this.setModal(newPath, "/", handlers);
      return;
    }

    // Handle base URL changes (sheet navigation)
    if (!this.currentModal && this.baseUrlChangeHandler) {
      this.popStateDepth++;
      try {
        await this.baseUrlChangeHandler(newPath);
      } finally {
        this.popStateDepth--;
      }
    }
  }
}

export const HistoryManager = new HistoryManagerImpl();
export namespace HistoryManager {
  export interface ModalHandlers {
    reveal: () => void;
    dismiss: () => Promise<void>;
  }

  export interface ModalState {
    url: string;
    baseUrl: string;
    handlers: ModalHandlers;
    dismissing: boolean;
  }
}

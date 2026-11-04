/**
 * The contract an external app implements is the Cookbook.App / Cookbook.Shell
 * types defined in this file and exposed through the public Cookbook namespace.
 * Members marked "cookbook extension" are optional for apps to use.
 */

/** The three mount points, each an empty element the app fills and owns until unmount. */
export interface CookbookSlots {
  /** The sidebar body (the shell keeps its own header, collapse control and status line). */
  queue: HTMLElement;
  /** The main column: the app draws its own toolbar, viewer and credit here. */
  main: HTMLElement;
  /** The details panel body. */
  details: HTMLElement;
}

/** The shell's class recipes, so the app's controls look like the shell's. */
export interface CookbookClasses {
  /** The main column's toolbar row; the shell pads it when a panel collapses over it. */
  toolbar?: string;
  button?: string;
  primary?: string;
  /** Details heading and status line. */
  name?: string;
  status?: string;
  /** A decision row of two buttons (styled as a pair; no phone mirror in this version). */
  decision?: string;
  /** The attribute that names a card (default data-card-name). */
  cardNameAttribute?: string;
  /** Cookbook extension: a selectable list and its rows (mark the current row aria-current="true"). */
  list?: string;
  listItem?: string;
}

export interface CookbookShell {
  readonly slots: CookbookSlots;
  /** A selector matching an ancestor of every slot; app styles are scoped under it. */
  readonly scope: string;
  readonly classes: CookbookClasses;
  /** Install a stylesheet where the slots can see it; returns its removal. */
  addStyles(css: string): () => void;
  /** A pick in the sidebar or main happened: on phones the shell returns to the main pane. */
  onSelect(): void;
  /** Save a file the app produced. */
  download(filename: string, type: string, data: string): void;
  /** Cookbook extension: the breadcrumb after the wordmark (empty hides it). */
  setCrumb?(text: string): void;
  /** Cookbook extension: run a layout change in the main slot with FLIP motion. */
  reflow?(change: () => void): void;
}

export interface CookbookApp {
  readonly id: string;
  readonly title: string;
  /** Fill the slots; may be called again after unmount with fresh slots, keeping app state. */
  mount(shell: CookbookShell): void;
  /** Stop listeners, observers and timers; leave state for the next mount. */
  unmount(): void;
  /** The app's state as JSON (the shell's header Export). */
  export(): unknown;
}

/** What a *.root.ts receives from the cookbook: it builds the shell and runs the app in it. */
export interface CookbookHost {
  run(app: CookbookApp, options?: { root?: HTMLElement }): void;
}

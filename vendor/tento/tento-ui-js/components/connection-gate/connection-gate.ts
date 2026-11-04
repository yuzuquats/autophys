import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { ConnectionGate } from "./gate-state";

/** The settings panel for a capability an app refuses to run until a boundary
 * check passes.
 *
 * The torrent daemon is the first: downloads stay off until the public exit IP
 * of a chosen tunnel has been verified. The app supplies the vocabulary — what
 * the fields are called, what the check means — and the panel owns everything
 * that is the same wherever a gate appears: which of the five verbs is offered
 * (`gate-state.ts`), the aria wiring, and the status line that says why the
 * capability is or is not running.
 *
 * Two behaviours are deliberate and were defects in the hand-rolled original:
 *
 *   - **Polling stops with the panel.** The original started a 5s `setInterval`
 *     at mount and never cleared it, so a panel the operator navigated away
 *     from kept polling for the life of the page. The timer is owned here and
 *     cleared on disconnect and recycle.
 *   - **Polling never overwrites the form.** A status refresh updates liveness
 *     only. Pulling the whole view into the inputs would discard whatever the
 *     operator was typing, on a five-second cadence, with no warning. */
@component({ name: "miniapp-connection-gate" })
export class ConnectionGatePanel extends LonaWebComponent {
  private $heading: HTMLElement = this.$("heading");
  private $intro: HTMLElement = this.$("intro");
  private $status: HTMLElement = this.$("status");
  private $fields: HTMLElement = this.$("fields");
  private $guidance: HTMLElement = this.$("guidance");
  private $actions: HTMLElement = this.$("actions");
  private $message: HTMLElement = this.$("message");

  private props: Option<ConnectionGatePanel.Props> = null;
  private inputs = new Map<string, HTMLSelectElement | HTMLInputElement>();
  private rows = new Map<string, HTMLElement>();
  private verbs = new Map<ConnectionGatePanel.Verb, HTMLButtonElement>();
  private view: Option<ConnectionGatePanel.View> = null;
  private busy = false;
  private poll: Option<number> = null;

  static makeWith(props: ConnectionGatePanel.Props): ConnectionGatePanel {
    return (ConnectionGatePanel.make() as ConnectionGatePanel).bind(props);
  }

  bind(props: ConnectionGatePanel.Props): this {
    this.props = props;
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", props.title);
    this.$heading.replaceChildren(Typography.h2(props.title));
    this.$intro.replaceChildren(Typography.p(props.intro));
    this.$guidance.replaceChildren(Typography.p(props.guidance));

    this.$fields.replaceChildren();
    this.inputs.clear();
    this.rows.clear();
    for (const field of props.fields) this.addField(field);

    this.$actions.replaceChildren();
    this.verbs.clear();
    for (const verb of ConnectionGatePanel.VERBS) {
      const label = props.labels?.[verb] ?? ConnectionGatePanel.LABELS[verb];
      const $button = Button.makeWithLight(label, {
        type: verb === "enable" ? "primary" : undefined,
      });
      $button.id = `gate-${verb}`;
      // `click`, not the gesture manager. `addPointerEvent` binds
      // `onpointerup` and `ondblclick` only (`gesture-manager.ts`), and a
      // native <button> activated by Enter or Space fires `click` and no
      // pointer event at all — so a pointer-only binding makes the panel
      // unreachable from the keyboard. The hand-rolled panel compensated with
      // an explicit keydown handler per button; a native button needs neither.
      $button.addEventListener("click", () => void this.run(verb));
      this.verbs.set(verb, $button);
      this.$actions.append($button);
    }

    this.paint(null);
    void this.run("load");
    return this;
  }

  private addField(field: ConnectionGatePanel.Field): void {
    const $row = document.createElement("label");
    $row.className = "field";
    const $input =
      field.kind === "select"
        ? document.createElement("select")
        : document.createElement("input");
    $input.id = `gate-field-${field.id}`;
    if ($input instanceof HTMLInputElement) {
      $input.type = "text";
      $input.autocomplete = "off";
      $input.placeholder = field.placeholder ?? "";
    } else {
      for (const option of field.options ?? []) {
        this.addOption($input, option.label, option.value);
      }
    }
    $input.addEventListener("input", () => {
      this.$message.replaceChildren(
        Typography.small("Unsaved changes. Test or save this connection."),
      );
      this.applyControls();
    });
    $row.htmlFor = $input.id;
    $row.append(Typography.small(field.label), $input);
    this.inputs.set(field.id, $input);
    this.rows.set(field.id, $row);
    this.$fields.append($row);
  }

  private addOption(
    $select: HTMLSelectElement,
    label: string,
    value: string,
  ): void {
    const $option = document.createElement("option");
    $option.textContent = label;
    $option.value = value;
    $select.append($option);
  }

  /** The form as typed. */
  draft(): Record<string, string> {
    const draft: Record<string, string> = {};
    for (const [id, $input] of this.inputs) {
      const field = this.props?.fields.find((f) => f.id === id);
      draft[id] = this.isVisible(field) ? $input.value.trim() : "";
    }
    return draft;
  }

  private isVisible(field: Option<ConnectionGatePanel.Field>): boolean {
    if (field?.visibleWhen == null) return true;
    const [id, value] = field.visibleWhen;
    return this.inputs.get(id)?.value === value;
  }

  private model(): ConnectionGate.Model {
    const view = this.view;
    return {
      busy: this.busy,
      loaded: view != null,
      active: view?.active === true,
      enabled: view?.enabled === true,
      configured: view != null && view.configured,
      dirty: view != null && !sameSettings(view.settings, this.draft()),
      editable: view?.editable !== false,
    };
  }

  private applyControls(): void {
    const model = this.model();
    const controls = ConnectionGate.controls(model);
    for (const [id, $input] of this.inputs) {
      const field = this.props?.fields.find((f) => f.id === id);
      $input.disabled = !controls.fields;
      const $row = this.rows.get(id);
      if ($row) $row.hidden = !this.isVisible(field);
    }
    for (const [verb, $button] of this.verbs) {
      $button.disabled = !controls[verb];
    }
    const withheld = ConnectionGate.enableReason(model);
    const $enable = this.verbs.get("enable");
    if ($enable) {
      $enable.title = withheld == null ? "" : ConnectionGatePanel.WHY[withheld];
    }
    this.setAttribute("aria-busy", String(this.busy));
  }

  private paint(view: Option<ConnectionGatePanel.View>, reset = true): void {
    if (view != null) this.view = view;
    const current = this.view;
    const running = current?.active === true;
    this.$status.dataset.active = String(running);
    this.$status.replaceChildren(
      Typography.p(
        current == null
          ? "Loading connection…"
          : `${running ? this.runningLabel() : this.stoppedLabel()} ${current.detail}`,
      ),
    );
    if (view != null && reset) {
      for (const [id, $input] of this.inputs) {
        const value = view.settings[id] ?? "";
        if ($input instanceof HTMLSelectElement) this.useValue($input, value);
        else $input.value = value;
      }
    }
    this.applyControls();
  }

  private runningLabel(): string {
    return this.props?.labels?.running ?? "Running.";
  }

  private stoppedLabel(): string {
    return this.props?.labels?.stopped ?? "Stopped.";
  }

  /** A saved value the server still holds but this client has never been
   * offered — a tunnel that is currently down, say — would otherwise vanish
   * from the select and read as "not configured". */
  private useValue($select: HTMLSelectElement, value: string): void {
    if (
      value !== "" &&
      ![...$select.options].some((option) => option.value === value)
    ) {
      this.addOption($select, `${value} (saved)`, value);
    }
    $select.value = value;
  }

  private async run(verb: ConnectionGatePanel.Verb | "load"): Promise<void> {
    const props = this.props;
    if (props == null || this.busy) return;
    this.busy = true;
    this.$message.replaceChildren(
      Typography.small(ConnectionGatePanel.PENDING[verb]),
    );
    this.applyControls();
    try {
      switch (verb) {
        case "load":
          this.paint(await props.transport.load());
          this.$message.replaceChildren();
          break;
        case "test": {
          const result = await props.transport.test(this.draft());
          this.$message.replaceChildren(
            Typography.small(
              `${result.ok ? "Connection verified." : "Connection unavailable."} ${result.detail}`,
            ),
          );
          break;
        }
        case "save":
          this.paint(await props.transport.save(this.draft()));
          this.$message.replaceChildren(
            Typography.small(
              `Settings saved. ${this.stoppedLabel()} Nothing started.`,
            ),
          );
          break;
        case "enable": {
          const view = await props.transport.enable();
          this.paint(view);
          this.$message.replaceChildren(
            Typography.small(
              view.active
                ? "Verified. The connection is in use."
                : `Still stopped. ${view.detail}`,
            ),
          );
          break;
        }
        case "disable":
          this.paint(await props.transport.disable());
          this.$message.replaceChildren(
            Typography.small("Stopped. Your host network is unchanged."),
          );
          break;
        case "refresh": {
          const discovered = await props.transport.refresh();
          for (const [id, options] of Object.entries(discovered.options)) {
            const $input = this.inputs.get(id);
            if (!($input instanceof HTMLSelectElement)) continue;
            const previous = $input.value;
            $input.replaceChildren();
            const field = props.fields.find((f) => f.id === id);
            for (const option of field?.options ?? []) {
              this.addOption($input, option.label, option.value);
            }
            for (const option of options) {
              this.addOption($input, option.label, option.value);
            }
            this.useValue($input, previous);
          }
          this.$message.replaceChildren(Typography.small(discovered.detail));
          break;
        }
      }
    } catch (error) {
      this.$message.replaceChildren(
        Typography.small(
          error instanceof Error ? error.message : String(error),
        ),
      );
    } finally {
      this.busy = false;
      this.applyControls();
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.startPolling();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopPolling();
  }

  onRecycle(): void {
    super.onRecycle();
    this.stopPolling();
    this.props = null;
    this.view = null;
    this.busy = false;
    this.inputs.clear();
    this.rows.clear();
    this.verbs.clear();
  }

  private startPolling(): void {
    const interval = this.props?.pollMs ?? ConnectionGatePanel.POLL_MS;
    if (this.poll != null || interval <= 0) return;
    this.poll = setInterval(() => void this.refreshLiveness(), interval);
  }

  private stopPolling(): void {
    if (this.poll == null) return;
    clearInterval(this.poll);
    this.poll = null;
  }

  /** Liveness only: `reset = false` leaves every input exactly as typed. */
  private async refreshLiveness(): Promise<void> {
    if (this.busy || this.props == null || this.view == null) return;
    try {
      const view = await this.props.transport.load();
      if (this.busy || this.view == null) return;
      this.paint({ ...this.view, ...view, settings: this.view.settings }, false);
    } catch {
      // A failed status poll is not worth interrupting an edit over; the next
      // explicit action reports the real error.
    }
  }

  static $styles = [
    css`
      :host {
        display: block;
        box-sizing: border-box;
      }
      #fields {
        display: grid;
        gap: 10px;
        margin: 12px 0;
      }
      .field {
        display: grid;
        gap: 4px;
      }
      .field[hidden] {
        display: none;
      }
      #actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      #status[data-active="true"] {
        color: var(--green, #51b748);
      }
      #status[data-active="false"] {
        color: var(--fg-secondary, #8a8a8e);
      }
      #message:empty {
        display: none;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="heading"></div>
    <div id="intro"></div>
    <div id="status" role="status"></div>
    <div id="fields"></div>
    <div id="guidance"></div>
    <div id="actions"></div>
    <div id="message" role="status"></div>
  `;

  static readonly POLL_MS = 5000;

  static readonly VERBS = [
    "test",
    "save",
    "enable",
    "disable",
    "refresh",
  ] as const;

  static readonly LABELS: Record<ConnectionGatePanel.Verb, string> = {
    test: "Test connection",
    save: "Save settings",
    enable: "Enable",
    disable: "Disable",
    refresh: "Refresh options",
  };

  static readonly PENDING: Record<
    ConnectionGatePanel.Verb | "load",
    string
  > = {
    load: "Loading saved connection…",
    test: "Checking the selected connection…",
    save: "Saving…",
    enable: "Verifying the saved connection…",
    disable: "Stopping…",
    refresh: "Looking for available options…",
  };

  static readonly WHY: Record<
    Exclude<ConnectionGate.Reason, null>,
    string
  > = {
    busy: "An action is already running.",
    loading: "Waiting for the server.",
    "read-only": "A host override owns this setting.",
    running: "Already running.",
    unsaved: "Save these changes first — enabling verifies what the server holds.",
    unconfigured: "No connection has been saved yet.",
    "already-stopped": "Nothing is running.",
  };
}

function sameSettings(
  saved: Record<string, string>,
  draft: Record<string, string>,
): boolean {
  const keys = new Set([...Object.keys(saved), ...Object.keys(draft)]);
  for (const key of keys) {
    if ((saved[key] ?? "") !== (draft[key] ?? "")) return false;
  }
  return true;
}

export namespace ConnectionGatePanel {
  export type Verb = (typeof ConnectionGatePanel.VERBS)[number];

  export interface Choice {
    label: string;
    value: string;
  }

  export interface Field {
    id: string;
    label: string;
    kind: "select" | "text";
    /** Static choices for a select; discovery appends to these. */
    options?: Choice[];
    placeholder?: string;
    /** Show this field only while another field holds a given value. */
    visibleWhen?: [string, string];
  }

  /** What the server says about the gate. */
  export interface View {
    settings: Record<string, string>;
    /** The capability is running. */
    active: boolean;
    /** The operator asked for it to run. */
    enabled: boolean;
    /** Settings exist to enable against. */
    configured: boolean;
    /** The server accepts writes to these settings. */
    editable: boolean;
    /** One sentence the panel shows verbatim. */
    detail: string;
  }

  export interface Transport {
    load(): Promise<View>;
    test(draft: Record<string, string>): Promise<{
      ok: boolean;
      detail: string;
    }>;
    save(draft: Record<string, string>): Promise<View>;
    enable(): Promise<View>;
    disable(): Promise<View>;
    refresh(): Promise<{
      options: Record<string, Choice[]>;
      detail: string;
    }>;
  }

  export interface Props {
    title: string;
    intro: string;
    guidance: string;
    fields: Field[];
    transport: Transport;
    /** Status-poll cadence; 0 disables polling (the storybook does). */
    pollMs?: number;
    labels?: Partial<Record<Verb, string>> & {
      running?: string;
      stopped?: string;
    };
  }
}

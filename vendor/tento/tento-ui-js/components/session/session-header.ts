import { html, LonaWebComponent } from "../../component";
import { Column } from "../../component-builtin";
import { component } from "../../component-decorators";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LonaIcons } from "../../ui/icons";
import { Typography } from "../../ui/typography";
import { ListCellLayout } from "../list/list-cell-layout";
import { StatusMark } from "../status/status-mark";
import { SessionHeaderStyles } from "./session-header-styles";

/** The review Storybook bundles with Bun, whose SVG loader returns a file path
 * instead of markup. Keep this tiny accessory glyph inline so the component
 * renders identically in the review harness and application bundles. */
const MORE_ICON =
  `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><g fill="currentColor"><circle cx="3.4" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.6" cy="8" r="1.25"/></g></svg>`;

/** The header of a long-running session, as one list cell.
 *
 * The number as a tag, then the title, then a description of what the session
 * was for — a state mark leading, an overflow accessory trailing. That is
 * the whole surface — everything an earlier revision put here (a back link, a
 * spelled-out state word beside a mark that already carried it, a row of
 * per-capability buttons, a facts strip) was either redundant with something
 * already on screen or an action with nowhere to go. Anything that earns its
 * way back belongs behind the accessory, not in the header.
 *
 * Built on `std-list-cell-layout` so the cell's padding, hover and slot
 * geometry stay the list's, not this component's. Styles live in
 * `session-header-styles.ts`, view models in `types.ts`. */
@component({ name: "std-session-header" })
export class SessionHeader extends LonaWebComponent {
  private $mount: HTMLElement = this.$("mount");
  private onMore: Option<() => void> = null;
  private revision: Option<string>;

  static makeWith(props: SessionHeader.Props): SessionHeader {
    return (SessionHeader.make() as SessionHeader).bind(props);
  }

  bind(props: SessionHeader.Props): this {
    const callbackChanged = this.onMore !== props.onMore;
    this.onMore = props.onMore;
    const revision = JSON.stringify({
      title: props.title,
      number: props.number,
      description: props.description,
      status: props.status,
      hasMore: props.onMore != null,
    });
    if (revision === this.revision && !callbackChanged) return this;
    this.revision = revision;
    this.$mount.replaceChildren(
      ListCellLayout.makeWith({
        $icon: this.$mark(props.status),
        $content: this.$content(props),
        $accessory: this.$accessory(),
      }, "wide"),
    );
    return this;
  }

  /** The state mark — the shared `std-status-mark`, so the rail and this
   * header cannot drift into two shapes or two palettes for the same fact.
   * `solid` because a session is a leaf: its state is its own, not a summary
   * of things it contains. */
  private $mark(status: SessionHeader.Status): HTMLElement {
    return StatusMark.makeWith({
      state: status.state,
      variant: "solid",
      label: status.label,
    });
  }

  private $content(props: SessionHeader.Props): HTMLElement {
    const $content = Column.make();
    $content.className = "content";

    // The number leads as a tag above the title rather than sitting beside it.
    // Inline, it competed with the title for the same line and pushed the
    // ellipsis in early; above, it reads as what it is — the handle this cell
    // is addressed by, not part of its name.
    if (props.number !== "") {
      const $number = Typography.small(props.number);
      $number.className = "number";
      $content.append($number);
    }

    // A real heading element, but no size class: the cell sets the size in
    // CSS, where it sits beside the other two lines' sizes and the offsets
    // computed from them. A size class here would put half that arithmetic in
    // the markup and half in the sheet.
    const $title = Typography.h2(props.title);
    $title.classList.add("title");
    $content.append($title);

    if (props.description !== "") {
      const $description = Typography.caption(props.description);
      $description.className = "description";
      $content.append($description);
    }
    return $content;
  }

  /** The overflow affordance. Always present, even with nothing behind it yet
   * — a cell whose accessory appears only sometimes reads as two different
   * cells. */
  private $accessory(): HTMLElement {
    const $more = document.createElement("button");
    $more.type = "button";
    $more.className = "more";
    $more.setAttribute("aria-label", "More options");
    $more.append(LonaIcons.$svg(MORE_ICON));
    $more.disabled = this.onMore == null;
    if (this.onMore != null) {
      GESTURE_MANAGER.addPointerEvent($more, { onClick: this.onMore });
    }
    return $more;
  }

  onRecycle(): void {
    super.onRecycle();
    this.onMore = null;
    this.revision = null;
    this.$mount.replaceChildren();
  }

  static $styles = [Typography.$style, ...SessionHeaderStyles.all];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="mount"></div>
  `;
}

export namespace SessionHeader {
  export type State = StatusMark.State;

  export interface Status {
    label: string;
    state: State;
  }

  export interface Props {
    title: string;
    /** The session's handle, e.g. `#72225`. Empty string omits it. */
    number: string;
    /** What the session was for, in one line. Empty string omits it. */
    description: string;
    status: Status;
    onMore: Option<() => void>;
  }
}

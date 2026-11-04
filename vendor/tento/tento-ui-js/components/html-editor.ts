import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css, Style } from "../component-styles";
import { Tracing } from "@tento-core/tracing";
import { Constants } from "@tento-core/constants";
import { DomUtils } from "../dom";
import { DomEventUtils } from "../dom-event-utils";
import { $$ } from "../fastdom";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Hotkeys } from "../hotkeys";
import { ScrollAncestorObserver } from "../scroll-utils";
import { Prosemirror } from "../ui/prosemirror-import";
import { ZIndex } from "../z-index";
import { prepareEditorHtml } from "./html-editor-input";
import { LinkEditPopover } from "./link-edit-popover";
import { Scrollbars } from "./scrollbars";
import { ScrollShadows } from "../ui/scroll-shadows";

@component({
  name: "std-html-editor",
})
export class HtmlEditor extends LonaWebComponent {
  static defaultSheet: Option<Style.Compat> = null;
  private $editor = this.$("editor");
  private view: Option<Prosemirror.EditorView>;
  private schema: Option<Prosemirror.Schema>;

  private parser: Option<Prosemirror.HtmlParser>;
  private serializer: Option<Prosemirror.HtmlSerializer>;

  private currentHtml: Option<string>;
  private editable: boolean = false;
  private initialized: boolean = false;

  private bindGeneration: number = 0;
  private props: Option<HtmlEditor.Props>;
  private pending = false;
  private delegate: (html: string) => void = Constants.EMPTY_FUNCTION;

  private updateScrollShadows = () => {
    ScrollShadows.updateScrollShadows(this, this.$editor);
  };
  onSizeChange = this.updateScrollShadows;

  connectedCallback() {
    super.connectedCallback();
    this.$editor.addEventListener("scroll", this.updateScrollShadows);
    if (this.props != null && this.view == null && !this.pending) {
      void this.bind(this.props).catch(error => Tracing.err("ui")("html-editor/reconnect-failed", error));
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.$editor.removeEventListener("scroll", this.updateScrollShadows);
    this.retireView();
  }

  private retireView(): void {
    if (this.props != null) this.props = { ...this.props, html: this.currentHtml ?? this.props.html };
    this.bindGeneration++;
    this.pending = false;
    this.currentLinkCleanup?.();
    this.currentLinkCleanup = null;
    this.view?.destroy();
    this.view = null;
    this.initialized = false;
    DomUtils.clearChildren(this.$editor);
  }

  onRecycle(): void {
    this.retireView();
    this.props = null;
    this.delegate = Constants.EMPTY_FUNCTION;
    this.currentHtml = null;
    super.onRecycle();
  }

  get value(): Option<string> {
    if (!this.view || !this.serializer) return "";
    const fragment = this.serializer.serializeFragment(
      this.view.state.doc.content,
    );
    const div = document.createElement("div");
    div.appendChild(fragment);
    return div.innerHTML;
  }

  set value(html: string) {
    if (!this.view || !this.parser) return;

    const view = this.view;
    const generation = this.bindGeneration;
    void this.parseHtml(html).then((doc) => {
      if (this.view !== view || generation !== this.bindGeneration) return;
      const state = view.state;
      const transaction = state.tr.replaceWith(
        0,
        state.doc.content.size,
        doc.content,
      );
      view.dispatch(transaction);
    }).catch(error => Tracing.err("ui")("html-editor/value-failed", error));
  }

  constructor() {
    super();
    this.onkeydown = this.onkeyup = (e) => {
      const hotkey = DomUtils.hotkeyIdentifier(e);
      if (!hotkey) return;
      if (Hotkeys.allowedHotkeyInEditor(hotkey)) return;
      if (Hotkeys.shouldPreventDefault(hotkey)) e.preventDefault();
      e.stopPropagation();
    };
    this.onpointerdown = DomEventUtils.STOP_PROPAGATION;
    this.onpointerup = DomEventUtils.STOP_PROPAGATION;
    this.ondblclick = DomEventUtils.STOP_PROPAGATION;
  }

  focusEditor() {
    if (this.view) {
      this.view.focus();
    } else {
      (this.$editor.firstElementChild as HTMLElement)?.focus();
    }
  }

  private onUpdateHtml(html: string) {
    const htmlChanged = this.currentHtml !== html;
    this.currentHtml = html;
    if (htmlChanged) this.delegate(html);
  }

  async bind(props: HtmlEditor.Props = {}): Promise<this> {
    let { html, placeholder, editable, onChange, minHeight, maxHeight } = props;
    const previousProps = this.props;
    this.props = props;
    const generation = ++this.bindGeneration;

    // Update synchronous state immediately — last caller wins
    const previous = {
      view: this.view,
      editable: this.editable,
      html: this.currentHtml,
    };

    this.delegate = onChange ?? Constants.EMPTY_FUNCTION;
    this.currentHtml = html;
    this.editable = editable != null ? editable : true;
    this.toggleAttribute("disabled", !this.editable);

    if (minHeight) {
      this.style.setProperty("--min-height", minHeight);
    }
    if (maxHeight) {
      this.style.setProperty("--max-height", maxHeight);
    }

    // Skip if nothing changed
    if (
      previous.html === html &&
      previous.editable === this.editable &&
      this.view != null && previousProps?.placeholder === placeholder
    ) {
      return this;
    }

    this.currentLinkCleanup?.();
    // Clean up previous view synchronously before any await
    if (previous.view) {
      DomUtils.clearChildren(this.$editor);
      previous.view.destroy();
      this.view = undefined;
    }

    this.pending = true;
    let prosemirror: Prosemirror;
    try { prosemirror = await Prosemirror.get(); }
    catch (error) { if (generation === this.bindGeneration) this.pending = false; throw error; }
    if (generation !== this.bindGeneration) return this;
    this.pending = false;

    // Initialize schema and serializers if not done yet
    if (!this.schema) {
      const { Schema, DOMParser, DOMSerializer } = prosemirror as any;
      this.schema = new Schema(HtmlEditor.schema());
      this.parser = DOMParser.fromSchema(this.schema);
      this.serializer = DOMSerializer.fromSchema(this.schema);
    }

    if (!this.initialized) {
      const { DEFAULT_STYLE } = prosemirror;
      HtmlEditor.defaultSheet ??= css(DEFAULT_STYLE);
      this.addStyle("default-prosemirror", HtmlEditor.defaultSheet);
      this.initialized = true;
    }

    // Parse initial HTML content
    const doc = await this.parseHtml(html);
    if (generation !== this.bindGeneration) return this;

    // The placeholder plugin checks the current document itself. Retain its
    // label for serialized empty HTML and for populated content cleared later.
    placeholder = placeholder ?? "Start typing...";
    await this.createEditorView(prosemirror, doc, placeholder, generation);

    return this;
  }

  private async parseHtml(html: Option<string>): Promise<any> {
    if (!this.parser || !html) {
      return this.schema!.nodeFromJSON({
        type: "doc",
        content: [{ type: "paragraph" }],
      });
    }

    const htmlWithLinks = this.linkifyPlainText(prepareEditorHtml(html));
    const htmlWithProcessedLinks =
      HtmlEditor.processGoogleDriveLinks(htmlWithLinks);
    const domParser = new DOMParser();
    const doc = domParser.parseFromString(htmlWithProcessedLinks, "text/html");
    return this.parser.parse(doc.body);
  }

  private linkifyPlainText(html: string): string {
    const urlPattern = /(\bhttps?:\/\/[^\s<]+|\bwww\.[^\s<]+)/g;

    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = html;

    const processTextNode = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || "";
        if (urlPattern.test(text)) {
          const fragment = document.createDocumentFragment();
          let lastIndex = 0;

          text.replace(urlPattern, (match, url, offset) => {
            if (offset > lastIndex) {
              fragment.appendChild(
                document.createTextNode(text.substring(lastIndex, offset)),
              );
            }

            const cleanUrl = url.replace(/[),;.!?]+$/, "");
            const trailingPunct = url.substring(cleanUrl.length);

            const href = cleanUrl.startsWith("www.")
              ? `https://${cleanUrl}`
              : cleanUrl;
            const link = document.createElement("a");
            link.href = href;
            link.target = "_blank";
            link.textContent = cleanUrl;
            fragment.appendChild(link);

            if (trailingPunct) {
              fragment.appendChild(document.createTextNode(trailingPunct));
            }

            lastIndex = offset + match.length;
            return match;
          });

          if (lastIndex < text.length) {
            fragment.appendChild(
              document.createTextNode(text.substring(lastIndex)),
            );
          }

          node.parentNode?.replaceChild(fragment, node);
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (element.tagName !== "A") {
          const children = Array.from(node.childNodes);
          for (const child of children) {
            processTextNode(child);
          }
        }
      }
    };

    processTextNode(tempDiv);
    return tempDiv.innerHTML;
  }

  private async createEditorView(
    prosemirror: Prosemirror,
    doc: any,
    placeholder: string,
    generation: number,
  ) {
    const { EditorState, EditorView, Plugins } = prosemirror;

    const onLinkClick: Prosemirror.OnLinkClick = (view, info) => {
      this.showLinkPopover(view, info);
    };

    const view = new EditorView(
      ($root: HTMLElement) => {
        $$.mutate(() => {
          if (this.view !== view) return;
          this.$editor.appendChild($root);
        });
      },
      {
        dispatchTransaction: (transaction) => {
          if (this.view !== view) return;
          const state = view.state.apply(transaction);
          view.updateState(state);
          const fragment = this.serializer!.serializeFragment(
            state.doc.content,
          );
          const div = document.createElement("div");
          div.appendChild(fragment);
          const html = div.innerHTML;
          this.onUpdateHtml(html);
        },
        state: EditorState.create({
          doc,
          schema: this.schema!,
          plugins: HtmlEditor.createPlugins(
            Plugins,
            placeholder,
            this.schema!,
            this.editable,
            this,
            onLinkClick,
          ),
        }),
        editable: () => this.editable,
      },
    );
    this.view = view;
  }

  private currentLinkCleanup: Option<EmptyFunction>;

  private showLinkPopover(
    view: Prosemirror.EditorView,
    info: Prosemirror.LinkClickInfo,
  ) {
    if (this.view !== view) return;
    this.currentLinkCleanup?.();

    const $popover = LinkEditPopover.make();
    $popover.setAttribute("context", "event-details");

    const updatePosition = () => {
      const anchorRect = info.$anchor.getBoundingClientRect();
      $popover.assignStyles({
        position: "fixed",
        top: anchorRect.bottom + 4 + "px",
        left: anchorRect.left + "px",
        zIndex: String(ZIndex.popoverLevel()),
      });
    };

    updatePosition();
    document.body.appendChild($popover);

    const scrollObserver = new ScrollAncestorObserver(
      info.$anchor,
      updatePosition,
    );
    scrollObserver.observe();

    let dismissed = false;
    const cleanup = () => {
      if (dismissed) return;
      dismissed = true;
      scrollObserver.unobserve();
      GESTURE_MANAGER.clearOnClickOutside($popover);
      Hotkeys.clearEscapeHandler($popover);
      $popover.remove();
      if (this.currentLinkCleanup === cleanup) this.currentLinkCleanup = null;
    };

    $popover.bind({
      href: info.href,
      onOpen: (href) => {
        if (dismissed || this.view !== view) return;
        window.open(href, "_blank", "noopener,noreferrer");
      },
      onSave: (newHref) => {
        if (dismissed || this.view !== view) return;
        const { tr } = view.state;
        const linkMarkType = view.state.schema.marks.link;
        tr.removeMark(info.from, info.to, linkMarkType);
        tr.addMark(
          info.from,
          info.to,
          linkMarkType.create({ href: newHref, linkType: info.linkType }),
        );
        view.dispatch(tr);
        cleanup();
      },
      onRemove: () => {
        if (dismissed || this.view !== view) return;
        const { tr } = view.state;
        const linkMarkType = view.state.schema.marks.link;
        tr.removeMark(info.from, info.to, linkMarkType);
        view.dispatch(tr);
        cleanup();
      },
    });

    GESTURE_MANAGER.toggleCleanUpOnClickOutside($popover, cleanup);
    Hotkeys.pushEscapeHandler($popover, cleanup);

    this.currentLinkCleanup = cleanup;
  }

  readonly commands = ((self) => ({
    toggleBold: () => {
      if (!self.view || !self.editable) return;
      HtmlEditor.Controls.toggleBold(self.view);
    },
    toggleItalic: () => {
      if (!self.view || !self.editable) return;
      HtmlEditor.Controls.toggleItalic(self.view);
    },
    toggleUnderline: () => {
      if (!self.view || !self.editable) return;
      HtmlEditor.Controls.toggleUnderline(self.view);
    },
  }))(this);

  static $styles = [
    Scrollbars.$style,
    ScrollShadows.$styles,
    css`
      :host {
        min-height: var(--min-height, 24px);
        max-height: var(--max-height, none);
        overflow-x: hidden;
        cursor: text;
        position: relative;

        display: flex;
        flex-direction: column;
      }

      :host([disabled]) {
      }

      #editor {
        background-clip: padding-box;
        height: 100%;
        padding: var(--editor-padding, 12px);
        overflow-y: scroll;
        color: var(--text-sec);
        flex-grow: 1;
      }
    `,
    css`
      #editor > div {
        flex-grow: 1;
      }

      #editor h1 {
        --font-size: var(--h5-size);
      }

      #editor h2,
      #editor h3,
      #editor h4,
      #editor h5,
      #editor h6 {
        --font-size: var(--h6-size);
      }
    `,
    css`
      p {
        --margin-top: 0px;
        --margin-bottom: 8px;
      }

      h1,
      h2,
      h3,
      h4,
      h5,
      h6 {
        --margin-top: 12px;
        --margin-bottom: 12px;
      }

      .ProseMirror > :last-child {
        --margin-bottom: 0px;
      }

      .ProseMirror > :first-child {
        --margin-top: 0px;
      }
    `,
    css`
      ul, ol {
        margin: 8px 0;
        padding-left: 24px;
      }

      li {
        margin: 4px 0;
      }

      a {
        color: var(--link);
        text-decoration: none;
      }

      a:hover {
        text-decoration: underline;
      }

      code {
        background: var(--bg-surface-light);
        padding: 2px 4px;
        border-radius: 3px;
        font-family: monospace;
        font-size: 0.9em;
      }

      hr {
        border: none;
        border-top: 1px solid var(--divider);
        margin: 16px 0;
      }
    `,
  ];

  static $html = html`
    <div class="scroll-shadow-top"></div>
    <div class="scroll-shadow-bottom"></div>
    <std-col id="editor" class="hide-scroll-bars prose-headings"></std-col>
  `;
}

export namespace HtmlEditor {
  export interface Props {
    // Content
    html?: Option<string>;
    placeholder?: string;

    // Behavior
    editable?: boolean;
    autofocus?: boolean;

    // Callbacks
    onChange?: (html: string) => void;
    onFocus?: () => void;
    onBlur?: () => void;

    // Styling
    minHeight?: string;
    maxHeight?: string;
    className?: string;
  }

  export function schema(): {
    nodes: Record<string, any>;
    marks: Record<string, any>;
  } {
    return {
      nodes: {
        doc: { content: "block+" },

        paragraph: {
          content: "inline*",
          group: "block",
          parseDOM: [{ tag: "p" }],
          toDOM: () => ["p", 0],
        },

        heading: {
          attrs: { level: { default: 1 } },
          content: "inline*",
          group: "block",
          defining: true,
          parseDOM: [
            { tag: "h1", attrs: { level: 1 } },
            { tag: "h2", attrs: { level: 2 } },
            { tag: "h3", attrs: { level: 3 } },
            { tag: "h4", attrs: { level: 4 } },
            { tag: "h5", attrs: { level: 5 } },
            { tag: "h6", attrs: { level: 6 } },
          ],
          toDOM: (node: any) => [`h${node.attrs.level}`, 0],
        },

        bullet_list: {
          content: "list_item+",
          group: "block",
          parseDOM: [{ tag: "ul" }],
          toDOM: () => ["ul", 0],
        },

        ordered_list: {
          attrs: { start: { default: 1 } },
          content: "list_item+",
          group: "block",
          parseDOM: [
            {
              tag: "ol",
              getAttrs: (dom: any) => ({
                start: dom.hasAttribute("start")
                  ? +dom.getAttribute("start")
                  : 1,
              }),
            },
          ],
          toDOM: (node: any) => ["ol", { start: node.attrs.start }, 0],
        },

        list_item: {
          content: "paragraph block*",
          defining: true,
          parseDOM: [{ tag: "li" }],
          toDOM: () => ["li", 0],
        },

        text: {
          group: "inline",
        },

        hard_break: {
          inline: true,
          group: "inline",
          selectable: false,
          parseDOM: [{ tag: "br" }],
          toDOM: () => ["br"],
        },
      },

      marks: {
        bold: {
          parseDOM: [
            { tag: "strong" },
            { tag: "b" },
            {
              style: "font-weight",
              getAttrs: (value: string) =>
                /^(bold|[5-9]\d{2,})$/.test(value) && null,
            },
          ],
          toDOM: () => ["strong", 0],
        },

        italic: {
          parseDOM: [
            { tag: "em" },
            { tag: "i" },
            { style: "font-style=italic" },
          ],
          toDOM: () => ["em", 0],
        },

        underline: {
          parseDOM: [
            { tag: "u" },
            {
              style: "text-decoration",
              getAttrs: (value: string) => value === "underline" && null,
            },
          ],
          toDOM: () => ["u", 0],
        },

        link: {
          attrs: {
            href: {},
            linkType: { default: undefined },
          },
          inclusive: false,
          parseDOM: [
            {
              tag: "a[href]",
              getAttrs: (dom: any) => ({
                href: dom.getAttribute("href"),
                linkType: dom.getAttribute("link-type") || undefined,
              }),
            },
          ],
          toDOM: (node: any) => {
            const attrs: any = {
              href: node.attrs.href,
              target: "_blank",
            };
            if (node.attrs.linkType) {
              attrs["link-type"] = node.attrs.linkType;
            }
            return ["a", attrs, 0];
          },
        },
      },
    };
  }

  export function processGoogleDriveLinks(html: string): string {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = html;

    const links = tempDiv.querySelectorAll("a.pastedDriveLink-0");
    for (const link of links) {
      link.classList.remove("pastedDriveLink-0");
      link.setAttribute("link-type", "google-drive");
    }

    return tempDiv.innerHTML;
  }

  export function createPlugins(
    Plugins: any,
    placeholder: string,
    schema: any,
    editable: boolean,
    $focusTarget: HTMLElement,
    onLinkClick?: Prosemirror.OnLinkClick,
  ): any[] {
    return [
      // Input rules for auto-formatting
      Plugins.buildInputRules(schema),

      // History for undo/redo
      Plugins.history(),

      // Default keymap for the schema
      Plugins.keymap(Plugins.defaultKeymap(schema)),

      // Undo/redo keymap
      Plugins.keymap({ "Mod-z": Plugins.undo, "Mod-y": Plugins.redo }),

      // Base keymap
      Plugins.keymap(Plugins.baseKeymap),

      // UI enhancements
      Plugins.dropCursor(),
      Plugins.gapCursor(),

      // Placeholder
      Plugins.placeholder($focusTarget, editable ? placeholder : ""),

      // Link click (shows edit popover)
      Plugins.linkClick(onLinkClick),
    ];
  }

  export namespace Controls {
    // Command methods for external control
    export function toggleBold(view: Prosemirror.EditorView) {
      const { state, dispatch } = view;
      const { tr, selection } = state;
      const markType = state.schema.marks.bold;

      if (selection.empty) {
        // Toggle mark for typing
        const marks = selection.$from.marks();
        if (markType.isInSet(marks)) {
          dispatch(tr.removeStoredMark(markType));
        } else {
          dispatch(tr.addStoredMark(markType.create()));
        }
      } else {
        // Toggle mark on selection
        const has = state.doc.rangeHasMark(
          selection.from,
          selection.to,
          markType,
        );
        if (has) {
          dispatch(tr.removeMark(selection.from, selection.to, markType));
        } else {
          dispatch(tr.addMark(selection.from, selection.to, markType.create()));
        }
      }
    }

    export function toggleItalic(view: Prosemirror.EditorView) {
      const { state, dispatch } = view;
      const { tr, selection } = state;
      const markType = state.schema.marks.italic;

      if (selection.empty) {
        const marks = selection.$from.marks();
        if (markType.isInSet(marks)) {
          dispatch(tr.removeStoredMark(markType));
        } else {
          dispatch(tr.addStoredMark(markType.create()));
        }
      } else {
        const has = state.doc.rangeHasMark(
          selection.from,
          selection.to,
          markType,
        );
        if (has) {
          dispatch(tr.removeMark(selection.from, selection.to, markType));
        } else {
          dispatch(tr.addMark(selection.from, selection.to, markType.create()));
        }
      }
    }

    export function toggleUnderline(view: Prosemirror.EditorView) {
      const { state, dispatch } = view;
      const { tr, selection } = state;
      const markType = state.schema.marks.underline;

      if (selection.empty) {
        const marks = selection.$from.marks();
        if (markType.isInSet(marks)) {
          dispatch(tr.removeStoredMark(markType));
        } else {
          dispatch(tr.addStoredMark(markType.create()));
        }
      } else {
        const has = state.doc.rangeHasMark(
          selection.from,
          selection.to,
          markType,
        );
        if (has) {
          dispatch(tr.removeMark(selection.from, selection.to, markType));
        } else {
          dispatch(tr.addMark(selection.from, selection.to, markType.create()));
        }
      }
    }
  }
}

import { Carousel } from "./carousel";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );

/** Browser integration checks. Bundle with the normal DOM/fastdom initializers. */
export async function verifyCarousel(): Promise<string[]> {
  const results: string[] = [];
  const carousel = Carousel.make();
  carousel.setAttribute("aria-label", "Examples");
  carousel.setAttribute("role", "group");
  carousel.style.cssText = "width:500px;height:200px;";
  document.body.append(carousel);
  const pages = (count: number) =>
    Array.from({ length: count }, () => {
      const page = document.createElement("div");
      const button = document.createElement("button");
      button.textContent = "Action";
      page.append(button);
      return page;
    });
  const key = (target: Element, key: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      composed: true,
      cancelable: true,
      ...extra,
    });
    target.dispatchEvent(event);
    return event;
  };
  const pointer = (
    target: EventTarget,
    type: string,
    x: number,
    y = 30,
    id = 7,
  ) => {
    const event = new PointerEvent(type, {
      pointerId: id,
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return event;
  };
  try {
    carousel.setPage(0, 0, false);
    check(carousel.currentPageIndex === 0, "Unbound empty state");
    const old = pages(2);
    carousel.domBind(old);
    carousel.setPage(1, undefined, false);
    old[0].style.backgroundColor = "red";
    old[0].classList.add("consumer-class");
    const one = pages(1);
    check(
      old[0].style.backgroundColor === "red" &&
        old[0].classList.contains("consumer-class"),
      "Unowned page styles/classes lost",
    );
    carousel.domBind(one);
    check(
      carousel.$("page-container").children.length === 1 &&
        carousel.currentPageIndex === 0 && !old[0].isConnected,
      "Replacement/shrink failed",
    );
    check(
      !old[0].hasAttribute("aria-hidden") && !old[0].classList.contains("page"),
      "Retired page ownership not restored",
    );
    carousel.domBind(one);
    check(
      carousel.$("page-container").firstElementChild === one[0],
      "Reused element lost",
    );
    for (
      const node of [
        document.createTextNode("text"),
        document.createDocumentFragment(),
      ]
    ) {
      let rejected = false;
      try {
        carousel.domBind([node]);
      } catch (e) {
        rejected = e instanceof TypeError;
      }
      check(
        rejected && one[0].parentElement === carousel.$("page-container"),
        "Unsupported node mutated inventory",
      );
    }
    carousel.domBind([]);
    check(
      carousel.currentPageIndex === 0 &&
        carousel.$("page-container").children.length === 0,
      "Empty rebind failed",
    );
    results.push(
      "replacement, shrink, reuse, unsupported nodes and empty binding",
    );

    // The public array remains caller-owned; only explicit domBind replaces slides.
    for (
      const mutate of [
        (input: HTMLElement[]) => {
          input.length = 0;
        },
        (input: HTMLElement[]) => {
          input.splice(0, 3, input[2], input[0]);
        },
        (input: HTMLElement[]) => {
          input.push(document.createElement("div"));
        },
      ]
    ) {
      const input = pages(3);
      const installed = [...input];
      carousel.domBind(input);
      mutate(input);
      carousel.setPage(2, undefined, false);
      check(
        Number(carousel.currentPageIndex) === 2 &&
          carousel.$("page-container").children.length === 3 &&
          installed.every((page, i) =>
            carousel.$("page-container").children[i] === page &&
            page.inert === (i !== 2) &&
            page.getAttribute("aria-hidden") === String(i !== 2)
          ),
        "Caller array mutation corrupted owned inventory",
      );
      const appended = input.find((page) => !installed.includes(page));
      check(
        !appended?.hasAttribute("aria-hidden"),
        "Uninstalled page rendered",
      );
      carousel.previousPage();
      check(Number(carousel.currentPageIndex) === 1, "Owned navigation lost");
      carousel.domBind(input);
      check(
        carousel.$("page-container").children.length === input.length &&
          input.every((page, i) =>
            carousel.$("page-container").children[i] === page
          ),
        "Explicit rebind did not adopt caller changes",
      );
    }
    results.push(
      "owned inventory survives caller clear, splice/reorder and append",
    );

    for (const outer of ["navigate", "bind"]) {
      for (const nested of ["navigate", "bind"]) {
        const initial = pages(3);
        const replacement = pages(2);
        const discarded = pages(1);
        const notifications: number[] = [];
        const expected = nested === "bind" ? replacement : initial;
        const target = nested === "bind" ? 0 : 2;
        const onScroll = (_from: number, to: number) => {
          check(
            carousel.currentPageIndex === to,
            "Stale focus reentry callback",
          );
          check(
            expected.every((page, i) =>
              page.inert === (i !== to) &&
              page.getAttribute("aria-hidden") === String(i !== to) &&
              page.style.transform ===
                `translate(${(i - to) * 100}%, 0px) scale(${
                  i === to ? 1 : .95
                })`
            ),
            "Callback observed incomplete focus reentry render",
          );
          notifications.push(to);
        };
        carousel.domBind(initial);
        carousel.setPage(0, undefined, false);
        await frame();
        const focused = initial[0].querySelector("button")!;
        focused.focus();
        check(focused.matches(":focus"), "Blur regression lacked real focus");
        carousel.callbacks = { onScroll };
        focused.addEventListener("blur", () => {
          if (nested === "bind") carousel.domBind(replacement, 2, { onScroll });
          else carousel.setPage(2, undefined, false);
        }, { once: true });
        if (outer === "bind") carousel.domBind(discarded);
        else carousel.setPage(1, undefined, false);
        check(
          Number(carousel.currentPageIndex) === target &&
            carousel.$("page-container").children.length === expected.length &&
            expected.every((page, i) =>
              carousel.$("page-container").children[i] === page &&
              page.inert === (i !== target) &&
              page.getAttribute("aria-hidden") === String(i !== target) &&
              page.style.transform ===
                `translate(${(i - target) * 100}%, 0px) scale(${
                  i === target ? 1 : .95
                })`
            ) && notifications.length === 1 && notifications[0] === target &&
            carousel.matches(":focus"),
          `Blur ${outer}/${nested} supersession failed`,
        );
        carousel.callbacks = undefined;
      }
    }
    results.push(
      "real blur navigation/binding supersedes outer navigation/binding coherently",
    );

    const slides = pages(3);
    carousel.domBind(slides);
    for (const idx of [NaN, Infinity, -Infinity]) {
      let rejected = false;
      try {
        carousel.setPage(idx);
      } catch (e) {
        rejected = e instanceof RangeError;
      }
      check(
        rejected && carousel.currentPageIndex === 0,
        "Invalid index mutated state",
      );
    }
    for (const stop of [-1, .5, NaN, Infinity]) {
      let rejected = false;
      try {
        carousel.setPage(1, stop);
      } catch (e) {
        rejected = e instanceof RangeError;
      }
      check(rejected, "Invalid stop accepted");
    }
    for (const duration of [-1, NaN, Infinity]) {
      let rejected = false;
      try {
        carousel.setPage(1, 3, true, duration);
      } catch (e) {
        rejected = e instanceof RangeError;
      }
      check(
        rejected && carousel.currentPageIndex === 0,
        "Invalid duration mutated state",
      );
    }
    for (const easing of ["invalid-easing", "inherit", "var(--easing)"]) {
      let rejected = false;
      try {
        carousel.setPage(1, 3, true, 10, easing);
      } catch (e) {
        rejected = e instanceof TypeError;
      }
      check(
        rejected && carousel.currentPageIndex === 0,
        "Invalid easing mutated state",
      );
    }
    carousel.setPage(99, 99, false);
    check(Number(carousel.currentPageIndex) === 2, "Stops exceed inventory");
    carousel.setPage(.8, 3, false);
    check(
      Number(carousel.currentPageIndex) === 1,
      "Settled index not integral",
    );
    carousel.setPage(0, 0, false);
    check(slides.every((page) => page.inert), "Zero stops exposed page");
    carousel.setPage(0, 3, false);
    let coherent = false;
    carousel.callbacks = {
      onScroll: (_from, to) => {
        coherent = carousel.currentPageIndex === to &&
          slides[to].getAttribute("aria-hidden") === "false";
      },
    };
    carousel.setPage(1, 3, false);
    check(coherent, "Callback preceded state update");
    carousel.callbacks = {
      onScroll: () => {
        throw new Error("consumer failure");
      },
    };
    try {
      carousel.setPage(2, 3, false);
    } catch { /* State must remain committed. */ }
    check(
      Number(carousel.currentPageIndex) === 2 && !slides[2].inert,
      "Thrown callback interrupted state",
    );
    carousel.callbacks = {
      onScroll: (_from, to) => {
        if (to === 1) carousel.setPage(2, 3, false);
      },
    };
    carousel.setPage(1, 3, false);
    check(
      Number(carousel.currentPageIndex) === 2 && !slides[2].inert,
      "Reentry overwritten",
    );
    carousel.callbacks = undefined;
    results.push(
      "finite bounds, timing validation, callback coherence/exception/reentry",
    );

    carousel.setPage(0, 3, false);
    check(
      slides[1].inert && slides[1].getAttribute("aria-hidden") === "true",
      "Inactive slide exposed",
    );
    const button = slides[0].querySelector("button")!;
    button.focus();
    carousel.setPage(1, 3, false);
    check(
      carousel.matches(":focus") && slides[0].inert,
      "Focus hidden in outgoing page",
    );
    slides[0].querySelector("button")!.focus();
    check(carousel.matches(":focus"), "Inert content accepted focus");
    check(
      carousel.getAttribute("aria-label") === "Examples" &&
        carousel.getAttribute("role") === "group",
      "Host attributes overwritten",
    );
    carousel.setPage(0, 3, false);
    const input = document.createElement("input");
    slides[0].append(input);
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    slides[0].append(editor);
    const nested = document.createElement("div");
    nested.setAttribute("role", "slider");
    slides[0].append(nested);
    const shadowHost = document.createElement("div");
    slides[0].append(shadowHost);
    const shadowEditor = document.createElement("input");
    shadowHost.attachShadow({ mode: "open" }).append(shadowEditor);
    for (const target of [input, editor, nested, button, shadowEditor]) {
      check(
        !key(target, "ArrowRight").defaultPrevented &&
          carousel.currentPageIndex === 0,
        "Descendant arrow hijacked",
      );
    }
    slides[0].contentEditable = "true";
    check(
      !key(slides[0], "ArrowRight").defaultPrevented &&
        carousel.currentPageIndex === 0,
      "Editable page root hijacked",
    );
    slides[0].removeAttribute("contenteditable");
    check(
      !key(carousel, "ArrowRight", { ctrlKey: true }).defaultPrevented,
      "Modified key hijacked",
    );
    const handled = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    carousel.dispatchEvent(handled);
    check(carousel.currentPageIndex === 0, "Handled key navigated");
    check(
      key(carousel, "ArrowRight").defaultPrevented &&
        Number(carousel.currentPageIndex) === 1,
      "Host arrow failed",
    );
    results.push(
      "inactive focus, focus recovery, host attributes and composed editing keyboard paths",
    );

    for (const width of [200, 500, 1000]) {
      carousel.style.width = `${width}px`;
      await frame();
      carousel.setPage(0, 3, false);
      pointer(slides[0], "pointerdown", 150);
      pointer(window, "pointermove", 150 - width * .3);
      check(
        Math.abs(carousel.currentPageIndex - .3) < .001,
        `Drag width scaling ${width}`,
      );
      pointer(window, "pointerup", 150 - width * .3);
      check(
        Number(carousel.currentPageIndex) === 1,
        `Width-relative release ${width}`,
      );
    }
    carousel.style.width = "500px";
    await frame();
    carousel.setPage(0, 3, false);
    pointer(slides[0], "pointerdown", 150);
    carousel.style.width = "1000px";
    await frame();
    pointer(window, "pointermove", 0);
    check(
      Math.abs(carousel.currentPageIndex - .3) < .001,
      "Mid-drag resize changed coordinate basis",
    );
    pointer(window, "pointercancel", 0);
    for (
      const end of [
        "pointercancel",
        "Escape",
        "blur",
        "disconnect",
        "lostpointercapture",
      ]
    ) {
      carousel.setPage(0, 3, false);
      pointer(slides[0], "pointerdown", 150);
      pointer(window, "pointermove", 70);
      check(
        carousel.currentPageIndex > 0 && carousel.currentPageIndex < 1,
        "No fractional drag before cancel",
      );
      if (end === "Escape") key(window as unknown as Element, "Escape");
      else if (end === "disconnect") carousel.remove();
      else if (end === "blur") window.dispatchEvent(new Event("blur"));
      else pointer(end === "lostpointercapture" ? carousel : window, end, 70);
      check(
        Number(carousel.currentPageIndex) === 0 &&
          carousel.style.userSelect !== "none",
        `Unsettled ${end}`,
      );
      pointer(window, "pointermove", -400);
      check(Number(carousel.currentPageIndex) === 0, `Stale listener ${end}`);
      if (!carousel.isConnected) document.body.append(carousel);
    }
    carousel.setPage(0, 3, false);
    pointer(input, "pointerdown", 150);
    pointer(window, "pointermove", 50);
    pointer(window, "pointerup", 50);
    check(carousel.currentPageIndex === 0, "Interactive pointer hijacked");
    pointer(slides[0], "pointerdown", 150);
    pointer(window, "pointermove", 148, 90);
    pointer(window, "pointerup", 148, 90);
    check(carousel.currentPageIndex === 0, "Vertical intent navigated");
    pointer(slides[0], "pointerdown", 150);
    pointer(window, "pointermove", 50, 30, 8);
    check(carousel.currentPageIndex === 0, "Secondary pointer moved carousel");
    pointer(window, "pointercancel", 150);
    const edges = [-1, -2, -4, -6].map((idx) =>
      Carousel.progressToTransform(idx, 3)[0].translate
    );
    check(
      edges.every((value, i) =>
        value > 0 && value < 1 / 3 && (i === 0 || value > edges[i - 1])
      ),
      "Nonmonotonic edge feedback",
    );
    results.push(
      "200/500/1000px drags, cancel/Escape/blur/detach/lost capture, editing/vertical/secondary pointer and bounded overscroll",
    );

    // Synthetic clicks qualify handler arbitration, not native click synthesis.
    carousel.setPage(0, 3, false);
    let activations = 0;
    const activate = () => activations++;
    slides[0].addEventListener("click", activate);
    const click = (detail: number) => {
      const event = new MouseEvent("click", {
        detail,
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      slides[0].dispatchEvent(event);
      return event;
    };
    try {
      pointer(slides[0], "pointerdown", 150);
      pointer(window, "pointermove", 148);
      pointer(window, "pointerup", 148);
      check(
        !click(1).defaultPrevented && Number(activations) === 1,
        "Normal pointer tap swallowed",
      );

      pointer(slides[0], "pointerdown", 150);
      pointer(window, "pointermove", 100);
      pointer(window, "pointerup", 100);
      check(
        !click(0).defaultPrevented && Number(activations) === 2,
        "Keyboard/programmatic detail=0 activation swallowed after drag",
      );
      check(
        click(1).defaultPrevented && Number(activations) === 2,
        "Horizontal ghost click reached slide activation",
      );

      // A fresh press must clear suppression even if no ghost click arrived.
      pointer(slides[0], "pointerdown", 150);
      pointer(window, "pointermove", 100);
      pointer(window, "pointerup", 100);
      pointer(slides[0], "pointerdown", 150);
      pointer(window, "pointerup", 150);
      check(
        !click(1).defaultPrevented && Number(activations) === 3,
        "Next independent pointer interaction swallowed",
      );
    } finally {
      slides[0].removeEventListener("click", activate);
    }
    results.push(
      "observable tap, detail=0, horizontal ghost click and next pointer activation arbitration",
    );

    carousel.setPage(0, 3, false);
    carousel.setPage(1, 3, true, 1000);
    await frame();
    const before = getComputedStyle(slides[0]).transform;
    carousel.setPage(0, 3, true, 1000);
    const animation = slides[0].getAnimations()[0];
    check(
      !!animation &&
        (animation.effect as KeyframeEffect).getKeyframes()[0].transform ===
          before,
      "Interruption did not start at displayed transform",
    );
    carousel.setPage(0, 3, false);
    carousel.setPage(1, 3, true, 1000, "linear");
    const inFlight = slides.flatMap((page) => page.getAnimations());
    check(
      inFlight.length === slides.length,
      "Missing in-flight animation fixture",
    );
    await Promise.all(inFlight.map((item) => item.ready));
    // Seek live WAAPI animations, then pause: no assumption about elapsed time.
    for (const item of inFlight) {
      item.pause();
      item.currentTime = 370;
    }
    const width = slides[0].offsetWidth;
    const displayedX =
      new DOMMatrixReadOnly(getComputedStyle(slides[0]).transform).m41;
    const displayedOrigin = -displayedX / width;
    check(
      displayedOrigin > .2 && displayedOrigin < .6,
      "Fixture must visibly differ from both settled endpoints",
    );
    pointer(slides[0], "pointerdown", 150);
    const delta = 50;
    pointer(window, "pointermove", 150 - delta);
    const expected = displayedOrigin + delta / width;
    // 0.5 CSS px tolerates computed-matrix serialization, far below target-origin error.
    check(
      Math.abs(carousel.currentPageIndex - expected) < .5 / width,
      "Animation-to-drag fractional index ignored displayed origin",
    );
    const draggedX =
      new DOMMatrixReadOnly(getComputedStyle(slides[0]).transform).m41;
    check(
      Math.abs(draggedX - (displayedX - delta)) < .5,
      "Animation-to-drag visual translation jumped",
    );
    check(
      slides.every((page) => page.getAnimations().length === 0),
      "Animation masked drag",
    );
    pointer(window, "pointercancel", 100);
    check(
      Number(carousel.currentPageIndex) === Math.round(displayedOrigin) &&
        carousel.currentPageIndex >= 0 && carousel.currentPageIndex < 3 &&
        Math.abs(
            new DOMMatrixReadOnly(getComputedStyle(slides[0]).transform).m41 +
              Math.round(displayedOrigin) * width,
          ) < .5,
      "Interrupted drag did not settle visually to bounded rounded origin",
    );
    carousel.setPage(1, 3, true, 1000);
    carousel.remove();
    check(
      slides.every((page) => page.getAnimations().length === 0),
      "Detached animation retained",
    );
    document.body.append(carousel);
    key(carousel, "ArrowRight");
    check(
      Number(carousel.currentPageIndex) === 2,
      "Reconnect duplicated keyboard",
    );
    results.push(
      "displayed animation interruption, drag cancellation of animation, detach and reconnect",
    );
    let sizes = 0;
    carousel.remove();
    carousel.onSizeChange = () => sizes++;
    document.body.append(carousel);
    await frame();
    check(sizes > 0, "Base resize observer did not connect");
    carousel.remove();
    const beforeDetachedResize = sizes;
    carousel.style.width = "480px";
    await frame();
    check(
      sizes === beforeDetachedResize,
      "Base resize observer did not disconnect",
    );
    document.body.append(carousel);
    await frame();
    check(
      sizes > beforeDetachedResize,
      "Base resize observer did not reconnect",
    );
    results.push("base ResizeObserver connect/disconnect/reconnect");
    return results;
  } finally {
    carousel.callbacks = undefined;
    carousel.remove();
  }
}

/** Controlled MediaQueryList events exercise preference changes without OS settings. */
export function verifyCarouselReducedMotion(): string[] {
  const original = window.matchMedia;
  class Motion extends EventTarget {
    matches = false;
    media = "(prefers-reduced-motion: reduce)";
    onchange = null;
    addListener() {}
    removeListener() {}
  }
  const motion = new Motion();
  window.matchMedia = () => motion as unknown as MediaQueryList;
  const carousel = Carousel.make();
  const pages = [document.createElement("div"), document.createElement("div")];
  try {
    document.body.append(carousel);
    carousel.domBind(pages);
    carousel.setPage(1);
    check(
      pages[0].getAnimations().length === 1,
      "Animation missing before preference change",
    );
    motion.matches = true;
    motion.dispatchEvent(new Event("change"));
    check(
      pages.every((page) => page.getAnimations().length === 0),
      "Preference change retained animations",
    );
    carousel.setPage(0);
    check(
      pages.every((page) => page.getAnimations().length === 0) &&
        carousel.currentPageIndex === 0,
      "Reduced-motion navigation animated",
    );
    return [
      "controlled reduced-motion preference change cancels animation and disables subsequent navigation animation",
    ];
  } finally {
    carousel.remove();
    window.matchMedia = original;
  }
}

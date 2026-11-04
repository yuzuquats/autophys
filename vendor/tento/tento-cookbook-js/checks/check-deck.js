// Evaluate on a cookbook landing page. Untrusted events check policy/state;
// use native input separately. Returns named assertions or throws on failure.
(async () => {
  const el = document.querySelector(".ck-deck"),
    viewport = el.querySelector(".ck-deck-viewport");
  const pages = [...el.querySelectorAll(".ck-deck-page")],
    track = el.querySelector(".ck-deck-track");
  const [prev, next] = el.querySelectorAll(".ck-deck-arrow");
  const results = [], wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (name, pass) => {
    results.push({ name, pass });
    if (!pass) throw Error(JSON.stringify(results));
  };
  let pointerId = 70;
  const fire = (target, type, x = 300, y = 300) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerId,
        isPrimary: true,
        pointerType: "touch",
        button: 0,
        buttons: type === "pointermove" ? 1 : 0,
        clientX: x,
        clientY: y,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  const selected = () => pages.findIndex((p) => !p.inert);
  const state = (i) =>
    selected() === i &&
    el.querySelector("[role=status]").textContent ===
      `Slide ${i + 1} of ${pages.length}` &&
    prev.disabled === (i === 0) && next.disabled === (i === pages.length - 1);
  const matrix = (e) => new DOMMatrix(getComputedStyle(e).transform);
  const rest = (i) =>
    state(i) && !el.hasAttribute("data-moving") &&
    Math.abs(matrix(pages[i]).a - 1) < .0001 &&
    Math.abs(matrix(pages[i]).m41) < .1 &&
    Math.abs(matrix(track).a - 1) < .0001 && Math.abs(matrix(track).m41) < .1;
  // Recover any inspection drag and return to slide one.
  window.dispatchEvent(new Event("blur"));
  await wait(250);
  while (selected() > 0) {
    prev.click();
    await wait(550);
  }
  check(
    "full viewport without horizontal overflow",
    document.documentElement.scrollWidth === innerWidth &&
      Math.abs(viewport.clientWidth - innerWidth) <= 1,
  );
  check("resting first page fills well", rest(0));
  check(
    "touch policy on scrollable pages",
    getComputedStyle(pages[0]).touchAction === "pan-y pinch-zoom",
  );
  next.click();
  const animation = pages[0].getAnimations().find((a) =>
    a.effect.getKeyframes().some((f) => "transform" in f)
  );
  check(
    "500ms button motion",
    matchMedia("(prefers-reduced-motion: reduce)").matches
      ? !animation
      : animation?.effect.getTiming().duration === 500,
  );
  await wait(550);
  check("next page and accessible state", rest(1));
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    prev.click();
    await wait(550);
    next.click();
    for (const page of pages) {
      for (const a of page.getAnimations()) {
        if (a.effect.getKeyframes().some((f) => "transform" in f)) {
          a.pause();
          a.currentTime = 100;
        }
      }
    }
    pointerId++;
    fire(viewport, "pointerdown", 300);
    fire(window, "pointermove", 300 - viewport.clientWidth * .18);
    fire(window, "pointerup", 300 - viewport.clientWidth * .18);
    await wait(350);
    check("grabbing interrupted navigation does not skip a slide", rest(1));
  }
  next.click();
  await wait(120);
  const before = matrix(pages[1]);
  prev.click();
  const after = matrix(pages[1]);
  check(
    "interruption starts at displayed frame",
    matchMedia("(prefers-reduced-motion: reduce)").matches
      ? rest(1)
      : Math.abs(before.m41 - after.m41) < 2 &&
        Math.abs(before.a - after.a) < .005,
  );
  await wait(550);
  check("reverse interruption settles", rest(1));
  prev.click();
  await wait(550);
  const canvas = el.querySelector(".ck-deck-texture canvas");
  check(
    "texture-js canvas painted",
    canvas.width > 1 &&
      canvas.getContext("2d").getImageData(0, 0, 1, 1).data[3] === 255,
  );
  const snapshot = () => canvas.toDataURL();
  let pixels = snapshot();
  await wait(160);
  check("texture pauses at rest", pixels === snapshot());
  const selection = document.documentElement.style.cssText;
  pointerId++;
  fire(viewport, "pointerdown", 100);
  fire(window, "pointermove", 100 + viewport.clientWidth * .4);
  check(
    "endpoint translates and shrinks",
    matrix(track).m41 > 0 && matrix(track).a < 1 && matrix(track).a >= .95,
  );
  check(
    "horizontal gesture locks selection",
    getComputedStyle(document.documentElement).userSelect === "none",
  );
  const touch = new Event("touchmove", { bubbles: true, cancelable: true });
  Object.defineProperty(touch, "touches", { value: [{}] });
  viewport.dispatchEvent(touch);
  check("confirmed horizontal gesture blocks native Y", touch.defaultPrevented);
  pixels = snapshot();
  await wait(300);
  check(
    "texture animates only when allowed",
    matchMedia("(prefers-reduced-motion: reduce)").matches
      ? pixels === snapshot()
      : pixels !== snapshot(),
  );
  fire(window, "pointercancel", 100 + viewport.clientWidth * .4);
  await wait(250);
  check(
    "cancel restores page and selection",
    rest(0) && document.documentElement.style.cssText === selection,
  );
  pointerId++;
  fire(viewport, "pointerdown");
  fire(window, "pointermove", 290, 400);
  fire(window, "pointerup", 290, 400);
  check(
    "vertical gesture stays native",
    rest(0) && document.documentElement.style.cssText === selection,
  );
  pointerId++;
  fire(viewport, "pointerdown");
  fire(window, "pointermove", 280, 318);
  fire(window, "pointerup", 280, 318);
  check("diagonal gesture waits for horizontal intent", rest(0));
  pointerId++;
  fire(viewport, "pointerdown", 300);
  fire(window, "pointermove", 300 - viewport.clientWidth * .18);
  fire(window, "pointerup", 300 - viewport.clientWidth * .18);
  await wait(350);
  check("18 percent swipe advances", rest(1));
  pointerId++;
  fire(viewport, "pointerdown", 100);
  fire(window, "pointermove", 100 + viewport.clientWidth * .1);
  fire(window, "pointerup", 100 + viewport.clientWidth * .1);
  await wait(350);
  check("10 percent swipe springs back", rest(1));
  pointerId++;
  fire(viewport, "pointerdown", 100);
  fire(window, "pointermove", 100 + viewport.clientWidth * .3);
  viewport.dispatchEvent(
    new PointerEvent("lostpointercapture", { pointerId, bubbles: true }),
  );
  await wait(250);
  check("lost capture settles nearest slide", rest(1));
  const field = document.createElement("input");
  pages[1].append(field);
  pointerId++;
  fire(field, "pointerdown");
  fire(window, "pointermove", 50);
  fire(window, "pointerup", 50);
  field.remove();
  check("fields retain pointer ownership", rest(1));
  const region = document.createElement("div");
  region.setAttribute("data-carousel-interactive", "");
  pages[1].append(region);
  pointerId++;
  fire(region, "pointerdown");
  fire(window, "pointermove", 50);
  fire(window, "pointerup", 50);
  region.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      composed: true,
    }),
  );
  region.remove();
  check("interactive slide regions retain pointer ownership", rest(1));
  while (selected() < pages.length - 1) next.click();
  await wait(550);
  pointerId++;
  fire(viewport, "pointerdown", 300);
  fire(window, "pointermove", 300 - viewport.clientWidth * .4);
  check(
    "last endpoint translates and shrinks",
    matrix(track).m41 < 0 && matrix(track).a < 1 && matrix(track).a >= .95,
  );
  fire(window, "pointercancel", 300 - viewport.clientWidth * .4);
  await wait(250);
  check("last endpoint cancellation restores rest", rest(pages.length - 1));
  while (selected() > 0) prev.click();
  await wait(550);
  check("final first-page rest", rest(0));
  return {
    viewport: [innerWidth, innerHeight],
    reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
    results,
  };
})();

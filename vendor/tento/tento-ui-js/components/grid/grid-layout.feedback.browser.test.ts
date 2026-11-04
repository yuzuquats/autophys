// This browser regression deliberately opts out of shell protection. The
// shared grid itself must stop feedback and still accept legitimate changes.
export async function verifyGridFeedback(): Promise<unknown> {
  const Grid = customElements.get("std-grid-layout") as any;
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const frames = async (count: number) => {
    for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  };
  const viewport = document.createElement("div");
  viewport.style.cssText = "position:fixed;top:0;left:0;width:800px;height:500px;overflow:auto;z-index:50000";
  const shadow = viewport.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `:host::-webkit-scrollbar { width:15px; height:15px; }
    #card { container-type:inline-size; }
    #content { height:200px; }
    @container (width < 450px) { #content { height:700px; } }`;
  const grid = Grid.make(); grid.style.cssText = "display:block;width:100%";
  const card = document.createElement("div"); card.id = "card";
  const content = document.createElement("div"); content.id = "content";
  card.append(content); grid.append(card); shadow.append(style, grid);
  grid.bind(Grid.DEFAULT_CONFIG);
  let writes = 0; grid.onHeightChange = () => writes++;
  document.body.append(viewport);
  try {
    await frames(90);
    assert(grid.layoutSuspended, "Grid never stops the auto-gutter width/height feedback cycle");
    const stoppedAt = writes;
    const samples: number[][] = [];
    for (let i = 0; i < 30; i++) {
      await frames(1);
      samples.push([viewport.clientWidth, grid.height, card.offsetWidth, card.offsetHeight]);
    }
    assert(new Set(samples.map(sample => JSON.stringify(sample))).size === 1 && writes === stoppedAt,
      "Paused grid keeps changing geometry or scheduling writes");
    assert(stoppedAt < 24, "Grid needs too many writes to stop a two-state cycle");
    assert(card.offsetWidth <= viewport.clientWidth, "Cycle retained columns wider than the viewport");

    // A new content height must recover even while the host stays at the
    // cycle width, and recompute the columns retained by the pause.
    content.style.height = "350px";
    await frames(12);
    assert(!grid.layoutSuspended && grid.height >= 350 && card.offsetWidth < 450,
      "New child geometry did not resume normal column layout");
    viewport.style.width = "1000px";
    await frames(12);
    assert(!grid.layoutSuspended && card.offsetWidth > 450, "New container width did not reflow the grid");

    // Exercise child-height feedback without any host-width changes.
    viewport.style.width = "600px";
    content.style.height = "40px";
    grid.layoutGrid(); await frames(12);
    let heightWrites = 0;
    grid.onHeightChange = (height: number) => {
      heightWrites++;
      content.style.height = height < 100 ? "140px" : "40px";
    };
    content.style.height = "140px";
    await frames(60);
    assert(grid.layoutSuspended, "Child-height feedback never suspends");
    const heightStoppedAt = heightWrites;
    await frames(20);
    assert(heightWrites === heightStoppedAt && heightWrites < 24, "Child-height cycle keeps writing");
    grid.onHeightChange = null;
    content.style.height = "275px";
    await frames(12);
    assert(!grid.layoutSuspended && grid.height >= 275, "Paused child-height layout did not recover");

    // Border/padding must not shrink the grid back to content-box height.
    card.style.cssText = "padding:10px;border:3px solid transparent";
    grid.layoutGrid(); await frames(12);
    assert(grid.height >= card.offsetHeight && !grid.layoutSuspended,
      "Border-box height is mistaken for a feedback cycle");
    const borderHeight = grid.height;
    await frames(12);
    assert(grid.height === borderHeight, "Padded child height never settles");

    // Explicit requests, binding and lifecycle changes must release a pause.
    const trigger = async () => {
      card.style.cssText = "container-type:inline-size";
      content.style.removeProperty("height"); viewport.style.width = "800px";
      grid.layoutGrid(); await frames(60);
      assert(grid.layoutSuspended, "Expected a fresh feedback cycle");
    };
    await trigger();
    content.style.height = "200px"; grid.layoutGridSync();
    assert(!grid.layoutSuspended, "Explicit synchronous layout did not reset feedback");
    await trigger();
    content.style.height = "200px"; grid.bind(Grid.DEFAULT_CONFIG); await frames(12);
    assert(!grid.layoutSuspended, "Rebind did not reset feedback");
    await trigger();
    viewport.remove(); content.style.height = "200px"; document.body.append(viewport); await frames(12);
    assert(!grid.layoutSuspended && grid.height >= 200, "Reconnect retained stale feedback state");
    // One input snapshot may be delivered separately for every child. This
    // is an ordinary batch update, not a cycle of changing geometry.
    content.style.height = "150px";
    for (let i = 0; i < 12; i++) {
      const child = document.createElement("div"); child.style.height = "20px"; grid.append(child);
    }
    viewport.style.width = "1000px"; grid.layoutGrid(); await frames(12);
    for (const child of [...grid.children] as HTMLElement[]) child.style.height = "160px";
    await frames(12);
    assert(!grid.layoutSuspended && grid.height >= 7 * 164,
      "Simultaneous child resizes were mistaken for a cycle or lost height updates");
    for (const width of [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900]) {
      viewport.style.width = width + "px"; await frames(2);
      assert(!grid.layoutSuspended, "Evolving container resize was suspended");
    }
    await frames(12);
    assert(!grid.layoutTask && grid.childResizeTasks.size === 0, "Idle grid retains queued resize work");
    return { widthCycleWrites: stoppedAt, widthCycleSamples: samples, heightCycleWrites: heightStoppedAt,
      recovery: ["content", "container width", "explicit layout", "binding", "reconnect"], borderHeight };
  } finally { viewport.remove(); }
}


export async function verifyGridFeedbackSafety(): Promise<unknown> {
  const Grid = customElements.get("std-grid-layout") as any;
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const frames = async (count: number) => {
    for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  };
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const make = (width: number, heights: number[]) => {
    const wrapper = document.createElement("div");
    wrapper.style.cssText = `position:fixed;top:0;left:0;width:${width}px;z-index:50000`;
    const grid = Grid.make(); grid.style.cssText = "display:block;width:100%";
    grid.setAttribute("no-transition", "");
    const cards = heights.map(height => {
      const card = document.createElement("div"); card.style.cssText = `height:${height}px;box-sizing:content-box`;
      grid.append(card); return card;
    });
    wrapper.append(grid); document.body.append(wrapper); grid.bind(Grid.DEFAULT_CONFIG);
    return { wrapper, grid, cards };
  };
  const contained = (grid: any, cards: HTMLElement[]) => {
    const top = grid.getBoundingClientRect().top;
    const boxes = cards.map(card => card.getBoundingClientRect());
    assert(boxes.every(box => box.bottom - top <= grid.height + 0.5), "Grid clips a child's bottom");
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const horizontalOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const verticalOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      assert(horizontalOverlap < 0.5 || verticalOverlap < 0.5, "Cards overlap within a column");
    }
  };
  const cases: { name: string; error?: string }[] = [];
  const run = async (name: string, body: () => Promise<void>) => {
    try { await body(); cases.push({ name }); }
    catch (error) { cases.push({ name, error: String(error) }); }
  };
  await run("paused child-height feedback contains every card", async () => {
    const { wrapper, grid, cards } = make(380, [40, 50]);
    try {
      await frames(10);
      let writes = 0;
      grid.onHeightChange = (height: number) => { writes++; cards[0].style.height = height < 150 ? "140px" : "40px"; };
      cards[0].style.height = "140px"; await frames(60);
      assert(grid.layoutSuspended, "Child-height loop did not pause");
      contained(grid, cards);
      const stopped = writes; await frames(20);
      contained(grid, cards); assert(stopped === writes, "Paused height safety continues writing");
      // After quiet, a known cycle input must be accepted as a fresh change.
      grid.onHeightChange = null;
      cards[0].style.height = "140px"; await frames(4); await delay(120);
      cards[0].style.height = "40px"; await frames(6);
      assert(!grid.layoutSuspended && grid.height === 98, "Known input after quiet stayed suspended");
      contained(grid, cards);
    } finally { wrapper.remove(); }
  });
  await run("independent 120ms height changes remain responsive", async () => {
    const { wrapper, grid, cards } = make(380, [100, 100]);
    try {
      await frames(10);
      for (let i = 0; i < 12; i++) {
        cards[0].style.height = i % 2 ? "100px" : "200px";
        await delay(120);
        assert(!grid.layoutSuspended, "Independent height animation was mistaken for feedback");
        contained(grid, cards);
      }
      cards[0].style.height = "200px"; await frames(8);
      contained(grid, cards); assert(grid.height === 308, "Final independent height is stale");
    } finally { wrapper.remove(); }
  });
  await run("six-frame container toggles retain responsive columns", async () => {
    const { wrapper, grid, cards } = make(900, [100, 100]);
    try {
      await frames(10);
      for (let i = 0; i < 4; i++) {
        wrapper.style.width = "700px"; await frames(6);
        assert(!grid.layoutSuspended, "Slow narrow container change was suspended");
        contained(grid, cards);
        wrapper.style.width = "900px"; await frames(6);
        assert(!grid.layoutSuspended && cards[0].offsetWidth === 448, "Wide container retained stale columns");
        contained(grid, cards);
      }
    } finally { wrapper.remove(); }
  });
  await run("padding-only and border-only changes update layout", async () => {
    const { wrapper, grid, cards } = make(380, [100, 50]);
    try {
      await frames(10);
      cards[0].style.padding = "20px"; await frames(8);
      contained(grid, cards); assert(grid.height === 198, "Padding-only change was not observed");
      cards[0].style.border = "13px solid transparent"; await frames(8);
      contained(grid, cards); assert(grid.height === 224, "Border-only change was not observed");
      assert(!grid.layoutSuspended, "Decoration changes were mistaken for feedback");
    } finally { wrapper.remove(); }
  });
  const failures = cases.filter(result => result.error);
  assert(!failures.length, "Grid feedback safety failures: " + JSON.stringify(failures));
  return cases;
}

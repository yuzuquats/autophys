import { Round } from "./round";

export async function verifyRoundAttributeFallback(): Promise<string[]> {
  const frame = () => new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const round = Round.makeWith({ bg: "red", radius: 50 });
  round.style.cssText = "display:block;width:40px;height:40px";
  document.body.append(round);
  const path = () => round.shadowRoot!.querySelector("std-squircle")!
    .shadowRoot!.querySelector("path")?.getAttribute("d");
  try {
    await frame(); await frame();
    const defaultPath = path();
    if (!defaultPath) throw new Error("round did not render");
    for (const invalid of ["oops", "", " ", "Infinity", "NaN", "-0.1", "1.1", "0.6oops"]) {
      round.setAttribute("side-curvature", "1"); await frame();
      if (path() === defaultPath) throw new Error("circular endpoint not exercised");
      round.setAttribute("side-curvature", invalid); await frame();
      if (path() !== defaultPath) throw new Error(`invalid curvature did not use default: ${invalid}`);
    }
    for (const valid of ["0", "1"]) {
      round.setAttribute("side-curvature", valid); await frame();
      if (!path() || path() === defaultPath) throw new Error(`valid endpoint lost: ${valid}`);
    }
    return ["8 invalid attributes default safely", "0 and 1 endpoints retained"];
  } finally { round.remove(); }
}

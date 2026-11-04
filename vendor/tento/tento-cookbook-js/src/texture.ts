import { drawAsciiFallback } from "../../tento-texture-js/backgrounds/canvas.ts";

/** Lazily register so pure cookbook imports also work outside the browser. */
export function createTexture(): {
  el: HTMLElement;
  setRunning(value: boolean): void;
} {
  if (!customElements.get("tento-cookbook-texture")) {
    customElements.define(
      "tento-cookbook-texture",
      class extends HTMLElement {
        private canvas = document.createElement("canvas");
        private reduced = matchMedia("(prefers-reduced-motion: reduce)");
        private frame = 0;
        private last = 0;
        private time = 0;
        private active = false;
        private visible = false;
        private resize = new ResizeObserver(() => this.draw());
        private intersection = new IntersectionObserver(([entry]) => {
          this.visible = entry.isIntersecting;
          this.sync();
        });

        connectedCallback() {
          if (!this.canvas.parentNode) this.append(this.canvas);
          this.resize.observe(this);
          this.intersection.observe(this);
          document.addEventListener("visibilitychange", this.sync);
          this.reduced.addEventListener("change", this.sync);
          this.draw();
        }
        disconnectedCallback() {
          this.resize.disconnect();
          this.intersection.disconnect();
          document.removeEventListener("visibilitychange", this.sync);
          this.reduced.removeEventListener("change", this.sync);
          cancelAnimationFrame(this.frame);
          this.frame = 0;
          this.last = 0;
          this.visible = false;
        }
        setRunning(value: boolean) {
          if (this.active === value) return;
          this.active = value;
          this.sync();
        }
        private sync = () => {
          cancelAnimationFrame(this.frame);
          this.frame = 0;
          this.last = 0;
          if (this.reduced.matches) this.draw();
          if (
            this.isConnected && this.active && this.visible &&
            !document.hidden && !this.reduced.matches
          ) {
            this.frame = requestAnimationFrame(this.tick);
          }
        };
        private tick = (now: number) => {
          if (!this.last || now - this.last >= 1000 / 12) {
            if (this.last) this.time += Math.min((now - this.last) / 1000, .2);
            this.last = now;
            this.draw();
          }
          this.frame = requestAnimationFrame(this.tick);
        };
        private draw() {
          const width = Math.max(
            1,
            Math.min(1200, Math.round(this.clientWidth)),
          );
          const height = Math.max(
            1,
            Math.min(1200, Math.round(this.clientHeight)),
          );
          if (this.canvas.width !== width) this.canvas.width = width;
          if (this.canvas.height !== height) this.canvas.height = height;
          const ctx = this.canvas.getContext("2d");
          if (!ctx) return;
          ctx.fillStyle = "#202020";
          ctx.fillRect(0, 0, width, height);
          drawAsciiFallback(
            ctx,
            width,
            height,
            this.reduced.matches ? 0 : this.time,
            { art: ["#656565", "#484848", "#303030"] },
          );
        }
      },
    );
  }
  const el = document.createElement("tento-cookbook-texture") as HTMLElement & {
    setRunning(value: boolean): void;
  };
  el.className = "ck-deck-texture";
  el.setAttribute("aria-hidden", "true");
  return { el, setRunning: (value) => el.setRunning(value) };
}

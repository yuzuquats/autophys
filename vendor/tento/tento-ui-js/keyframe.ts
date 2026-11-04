export namespace SimpleKeyframe {
  export function builder(): Builder {
    return new Builder();
  }

  export class Builder {
    private before: Keyframe = {};
    private after: Keyframe = {};
    private finish: CSSStyleWithVariables = {};

    build(): Keyframe[] {
      return [this.before, this.after];
    }

    animate(
      $e: HTMLElement,
      animate: boolean,
      duration: number,
      shouldCancel: () => boolean = () => false,
      onFinish: () => void = () => {},
    ) {
      const finish = () => {
        if (shouldCancel()) return;
        $e.assignStyles(this.finish);
        onFinish();
      };

      if (animate) {
        const animate = $e.animate(this.build(), {
          duration,
        });
        animate.onfinish = finish;
        animate.oncancel = () => {
          console.log("cancelled");
          finish();
        };
      } else {
        finish();
      }
    }

    apply(key: string, before: string, after: string): Builder {
      this.before[key] = before;
      this.after[key] = after;
      return this;
    }

    transform(b: string, a: string): Builder {
      this.before.transform = b;
      this.after.transform = a;
      return this;
    }

    slideIn(xPx: number = 0, yPx: number = 40): Builder {
      this.before.transform = `translate(${xPx}px, ${yPx}px)`;
      this.after.transform = "translate(0px, 0px)";
      this.finish.transform = "translate(0px, 0px)";
      return this;
    }

    slideOut(xPx: number = 0, yPx: number = 40): Builder {
      this.before.transform = "translate(0px, 0px)";
      this.after.transform = `translate(${xPx}px, ${yPx}px)`;
      this.finish.transform = `translate(${xPx}px, ${yPx}px)`;
      return this;
    }

    boxShadow(before: string, after: string): Builder {
      this.before.boxShadow = before;
      this.after.boxShadow = after;
      return this;
    }

    fade(fadein: boolean): Builder {
      return fadein ? this.fadeIn() : this.fadeOut();
    }

    fadeIn(): Builder {
      this.before.opacity = 0;
      this.after.opacity = 1;
      this.finish.opacity = String(1);
      return this;
    }

    fadeOut(): Builder {
      this.before.opacity = 1;
      this.after.opacity = 0;
      this.finish.opacity = String(0);
      return this;
    }
  }
}

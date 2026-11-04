import { Storybook } from "../ui/storybook";
import { VerifyProbe } from "./verify-probe";

// The storybook for dev-verify-probe. A `<std-storybook-card
// example="tento-ui-js/components/verify-probe.example.ts"
// class="VerifyProbeStoryBook">` in a review note renders exactly this, built
// from the commit's own source and run in the opaque-origin sandbox.
export class VerifyProbeStoryBook extends Storybook.Default {
  title(): string {
    return "VerifyProbe (dev-verify-probe)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Fresh card",
        render: () => VerifyProbe.make().bind({ label: "storybook card works", start: 0 }),
      },
      {
        title: "Click it — the count is live",
        render: () => VerifyProbe.make().bind({ label: "sandbox runs scripts", start: 41 }),
      },
    ];
  }
}

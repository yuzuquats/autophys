/**
 * The tutorial "Show me" ring as a soft halo in the Autophys blue (#5B8EC4, the mark's dot):
 * a 1px edge plus a faint 4px glow, instead of the cookbook's 2px ink ring with a dark 8px
 * band. It sits around the target and leaves the row's own selection visible (operator pick
 * T2, 2026-11-04). The ring element is the cookbook's .ck-target-ring on <body>.
 */
const style = document.createElement("style");
style.dataset.autophys = "tour-ring";
style.textContent = `
.ck-target-ring {
  box-shadow: 0 0 0 1px rgb(91 142 196 / 60%), 0 0 0 4px rgb(91 142 196 / 14%) !important;
}`;
document.head.append(style);

/**
 * The cookbook's own demo page: the vanilla shell running PlaceholderApp,
 * named after the page title so a build can label it per app.
 * Build: deno run -A tento-cookbook-js/build.ts --root tento-cookbook-js/demo/routes/index.root.ts --out <dir> --title <name>
 */
import { Cookbook } from "../../lib.ts";

const title = document.title || "Cookbook";
Cookbook.mount().run(new Cookbook.PlaceholderApp(title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title));

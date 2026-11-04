/**
 * The page `autophys serve` serves: the tento-cookbook-js shell running the
 * cookbook's own vanilla PlaceholderApp, named autophys. tento-web's
 * file-based router bundles this file as /index.root.js.
 */
import { Cookbook } from "@tento-cookbook/lib.ts";

Cookbook.mount().run(new Cookbook.PlaceholderApp("autophys", "Autophys"));

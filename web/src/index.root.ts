/**
 * The page `autophys serve` serves: the tento-cookbook-js shell running the
 * autophys app. Built by `deno task build` (tento-cookbook-js/build.ts) into
 * web/dist/, which ops/deploy.sh installs beside the binary.
 */
import { Cookbook } from "@tento-cookbook";
import { AutophysApp } from "./app.ts";

Cookbook.mount().run(new AutophysApp());

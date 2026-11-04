#!/usr/bin/env -S deno run -A
// External-kind adapter: policy comes from the governing tree's .rebar file.
import { checkCatalogue, inspectComponents } from "./check-charter.deno.ts";
import { stories, UI } from "./charter-lib.deno.ts";

export async function run(args: string[], input: string): Promise<unknown> {
  if (
    args.length !== 6 || args[0] !== "rebar-check" || args[1] !== "--rule" ||
    args[2] !== "-" || args[3] !== "--dir" || args[5] !== "--json"
  ) {
    throw new Error("Expected rebar-check --rule - --dir <directory> --json");
  }
  const rule = JSON.parse(input);
  if (rule == null || typeof rule !== "object" || Array.isArray(rule)) {
    throw new Error("The charter rule must be an object");
  }
  const dir = await Deno.realPath(args[4]);
  let records;
  if (rule.check === "components") {
    if (
      Object.keys(rule).some((key) => !["check", "strict"].includes(key)) ||
      (rule.strict !== undefined && typeof rule.strict !== "boolean")
    ) {
      throw new Error(
        "Components accepts only check and an optional boolean strict",
      );
    }
    if (dir !== await Deno.realPath(UI)) {
      throw new Error(
        "The components rule must govern this checker's tento-ui-js directory",
      );
    }
    records = await inspectComponents(rule.strict ?? false);
  } else if (rule.check === "catalogue") {
    if (
      Object.keys(rule).some((key) => !["check", "catalogue"].includes(key)) ||
      typeof rule.catalogue !== "string" || rule.catalogue.length === 0
    ) {
      throw new Error(
        "Catalogue requires an explicit catalogue path relative to its manifest",
      );
    }
    const path = new URL(rule.catalogue, `file://${dir}/`);
    if (path.protocol !== "file:" || !path.pathname.startsWith(`${dir}/`)) {
      throw new Error(
        "The catalogue path must stay inside its governing directory",
      );
    }
    const resolved = await Deno.realPath(path);
    if (!resolved.startsWith(`${dir}/`)) {
      throw new Error(
        "The catalogue path must stay inside its governing directory",
      );
    }
    // A missing catalogue is a configuration failure, never silently skipped.
    const catalogue = await Deno.readTextFile(resolved);
    records = checkCatalogue(await stories(), catalogue);
  } else {
    throw new Error(`Unknown charter check: ${rule.check}`);
  }
  return { datatype: "rebar.violations/v1", records };
}

if (import.meta.main) {
  try {
    const input = await new Response(Deno.stdin.readable).text();
    console.log(JSON.stringify(await run(Deno.args, input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}

/**
 * The autophys app, for now the vanilla tento-cookbook-js skeleton (operator
 * ruling, 2026-11-04): the cookbook's PlaceholderApp with autophys's id and
 * title, so its slots hold neutral placeholder rows, text and status only.
 * It imports nothing from tento-autophys-js. This is the basis to iterate
 * on: replace the slots' contents here, one piece at a time.
 */
import { Cookbook } from "@tento-cookbook";

export class AutophysApp extends Cookbook.PlaceholderApp {
  constructor() {
    super("autophys", "Autophys");
  }
}

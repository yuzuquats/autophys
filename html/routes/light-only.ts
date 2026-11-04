/**
 * Autophys is light only (the cookbook declares `color-scheme: light`). tento-ui's DarkMode
 * follows the OS on import and writes `color-scheme: dark` inline on <html>, which beats the
 * stylesheet and turns every native scrollbar and form control dark. Pin it to light without
 * saving a preference, so components reading DarkMode also render their light variants.
 */
import { DarkMode } from "@tento-ui/dark-mode.ts";

DarkMode.toggle(false, false);

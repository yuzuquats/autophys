import GoogleMeet from "@tento-ui/icons/googlemeet.svg";
import Zoom from "@tento-ui/icons/zoom.svg";
import Teams from "@tento-ui/icons/microsoftteams.svg";
import Webex from "@tento-ui/icons/webex.svg";
import { GlobeIcon, LonaIcons } from "../../../ui/icons";

/** Decorative provider mark; the adjacent text supplies its accessible name. */
export function conferenceProviderIcon(origin: string): SVGElement {
  let source = GlobeIcon;
  let color = "var(--text-ter)";
  if (/^google meet$/i.test(origin)) {
    source = GoogleMeet;
    color = "#00832d";
  } else if (/^zoom(?:\s|$)/i.test(origin)) {
    source = Zoom;
    color = "#2d8cff";
  } else if (/^(?:microsoft )?teams(?:\s|$)/i.test(origin)) {
    source = Teams;
    color = "#6264a7";
  } else if (/^(?:cisco )?webex(?:\s|$)/i.test(origin)) {
    source = Webex;
    color = "#00bceb";
  }
  const icon = LonaIcons.$svg(source);
  icon.style.color = color;
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  return icon;
}

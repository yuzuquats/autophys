import { Toast } from "../components/toast/toast";
import { Toaster } from "../components/toast/toaster";
import { DomUtils } from "../dom";
import { LonaIcons, WifiIcon } from "./icons";

export namespace IsOnline {
  let handle: Option<Toaster.Persistent.Handle>;

  export function enableNetworkStatusToast() {
    // dev("is-online/enabling network status toast");

    toggleToast(!navigator.onLine);
    // toggleToast(true);
    globalThis.addEventListener("online", () => toggleToast(false));
    globalThis.addEventListener("offline", () => toggleToast(true));
  }

  function toggleToast(offline: boolean) {
    // dev("is-online/toggle toast, offline=", offline);

    const showingUnconnected = handle != null;
    if (offline === showingUnconnected) return;

    if (offline) {
      if (handle) return;
      handle = Toaster.showPersistent(
        "network-online",
        Toast.makeWith({
          icon: LonaIcons.make(WifiIcon, {
            sizePx: 20,
            color: "var(--red)",
          }).assignStyles({
            marginLeft: "4px",
            marginRight: "12px",
          }),
          title: "You're not connected to the internet",
        }),
      );
    } else {
      handle?.dismiss();
    }
  }
}

import { Storybook } from "@tento-ui/ui/storybook";
import { Toast } from "./toast";
import { Button } from "../button/button";
import { Toaster } from "./toaster";
import { Prompt } from "../prompt";
import { LonaIcons, WifiIcon } from "../../ui/icons";
import { DomUtils } from "../../dom";

let persistentToastHandle: Option<Toaster.Persistent.Handle>;
let persistentNuxHandle: Option<Toaster.Persistent.Handle>;

export class ToastStoryBook extends Storybook.Default {
  title(): string {
    return "Toast";
  }

  tags(): string[] {
    return ["std-toast"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Toast",
        render: () => {
          return Toast.makeWith({
            title: "You've got mail",
          });
        },
      },
      {
        title: "Show Toast",
        render: () => {
          return Button.makeWithLight("Show Toast", {
            type: "primary",
            onClick: () => {
              const r = Math.floor(Math.random() * 4);
              [
                () =>
                  Toast.info("You earned a cake!", {
                    description:
                      "Cake was very delicious. It had lots of fruit.",
                  }),
                () =>
                  Toast.info("Deleted something!", {
                    undo: () => {},
                  }),
                () => Toast.error("Uh oh! Something went wrong"),
                () => Toast.warn("Warning"),
              ][r]();
            },
          });
        },
      },
      {
        title: "Throw Error",
        render: () => {
          Toast.toggleShowToastOnException(true);
          return Button.makeWithLight("Throw Error", {
            type: "primary",
            onClick: () => {
              throw new Error("wah wah");
            },
          });
        },
      },
      {
        title: "Show Persistent Toast",
        render: () => {
          return Button.makeWithLight("Toggle Persistent Toast", {
            type: "primary",
            onClick: () => {
              if (persistentToastHandle) {
                persistentToastHandle.dismiss();
                persistentToastHandle = null;
                return;
              }

              persistentToastHandle = Toaster.showPersistent(
                "internet-debug",
                Toast.makeWith({
                  icon: LonaIcons.make(WifiIcon, {
                    sizePx: 20,
                    color: "var(--red)",
                  }).assignStyles({
                    marginLeft: "4px",
                    marginRight: "12px",
                  }),
                  title: "You're not connected to the internet",
                  options: {
                    showClose: false,
                  },
                }),
              );
            },
          });
        },
      },
      {
        title: "Show Nux",
        render: () => {
          return Button.makeWithLight("Toggle Persistent Nux", {
            type: "primary",
            onClick: () => {
              if (persistentNuxHandle) {
                persistentNuxHandle.dismiss();
                persistentNuxHandle = null;
                return;
              }

              persistentNuxHandle = Toaster.showPersistent(
                "nux",
                Prompt.make()
                  .bind({
                    title: "Try this new feature",
                    description: "Just click here and here and here.",
                    onSubmit: () => {
                      Toast.info("You did it!");
                      persistentNuxHandle?.dismiss();
                      persistentNuxHandle = null;
                    },
                  })
                  .assignStyles({
                    width: "320px",
                    "--hero-height": "160px",
                  }),
              );
            },
          });
        },
      },
      {
        title: "Info Toast",
        render: () => {
          return Toast.makeWith({
            title: "Info Toast",
            variant: "info",
          });
        },
      },
      {
        title: "Warn Toast",
        render: () => {
          return Toast.makeWith({
            title: "Warn Toast",
            variant: "warn",
          });
        },
      },
      {
        title: "Error Toast",
        render: () => {
          return Toast.makeWith({
            title: "Error Toast",
            variant: "error",
          });
        },
      },
      {
        // What an uncaught error or unhandled rejection shows to a service
        // account: the toast's body is a whole std-exception.
        title: "Exception Toast",
        render: () => {
          return Toast.makeException(
            "TypeError: Failed to fetch dynamically imported module: https://dev--ui.lona.so/@/static/js/codemirror.min.js",
            {
              stack: `TypeError: Failed to fetch dynamically imported module
    at VendoredImport.load (index.root.js:48211:20)
    at async CodeMirror.get (index.root.js:48302:16)
    at async CodeMirrorStoryBook.render (index.root.js:91544:9)`,
              detail: "Caused by: Error: HTTP 404",
            },
          );
        },
      },
      {
        // Past three lines the bar clamps, and the whole message opens the
        // well instead, so the toast still fits a collapsed toaster's slot.
        title: "Exception Toast (long message)",
        render: () => {
          return Toast.makeException(
            "TypeError: Failed to fetch dynamically imported module: https://dev--static.lona.so/js/prosemirror.min.js?v=6&dev-mode=beta while hydrating the rich text editor",
            {
              stack: `TypeError: Failed to fetch dynamically imported module
    at VendoredImport.load (index.root.js:48211:20)
    at async ProsemirrorImport.get (index.root.js:48377:16)`,
            },
          );
        },
      },
      {
        title: "Description Toast",
        render: () => {
          return Toast.makeWith({
            title: "Warn Toast (Description)",
            variant: "warn",
            options: {
              description: "Some long description explaining what's going on",
            },
          });
        },
      },
      {
        title: "Long Text Toast",
        render: () => {
          return Toast.makeWith({
            title:
              "Your changes could not be saved because the connection to the server was interrupted while syncing several rows",
            options: {
              description:
                "We'll keep retrying automatically in the background. If this keeps happening, check that you're online and that the sheet hasn't been moved or deleted by another collaborator. No data has been lost — everything is still queued locally and will be reconciled once the connection is restored.",
            },
          });
        },
      },
      {
        // Repro: an unbreakable long URL has no soft-wrap opportunities, so
        // #content (flex-grow:1, no min-width:0) refuses to shrink below the
        // URL's intrinsic width and shoves the close button past #cell's edge.
        title: "URL Toast",
        render: () => {
          return Toast.makeWith({
            title:
              "https://example.com/very/long/path/segment/that/keeps/going/without/any/spaces/to/wrap/at?query=1234567890&token=abcdefghijklmnopqrstuvwxyz",
            options: {
              description:
                "https://example.com/very/long/path/segment/that/keeps/going/without/any/spaces/to/wrap/at",
            },
          });
        },
      },
    ];
  }
}

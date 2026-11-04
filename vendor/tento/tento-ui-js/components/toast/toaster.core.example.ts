import { Div } from "../../component-builtin";
import { LonaIcons, WifiIcon } from "../../ui/icons";
import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { Toast } from "./toast";
import { Toaster } from "./toaster";

// Both elements pin themselves to the viewport (`position: fixed`). Every
// example therefore builds its own toaster inside a transformed stage: a
// transform makes the stage the containing block for fixed descendants, so
// each card gets its own bottom-right corner and never touches the page's
// global `Toaster.instance`.

// The toast is a fixed 320px. Centre it while the stage is narrower than
// 360px and grow the inset to the app's 20px default once there is room.
const STAGE_INSET = "calc(-1 * clamp(4px, (100cqw - 320px) / 2, 20px))";

// Only the front toast's clock runs, so a long first clock holds a seeded
// stack in place until the reader adds or dismisses something. (setTimeout
// overflows past 2^31 ms, so not Infinity.)
const STAY_MS = 24 * 60 * 60 * 1000;

const NOTIFICATIONS: Toast.Props[] = [
  {
    title: "Moved “Design review” to Thursday",
    options: { description: "Thu, Oct 15 · 2:00 – 3:00 pm" },
  },
  { title: "Copied link to “Q4 roadmap”" },
  {
    title: "12 events synced from Google Calendar",
    options: { description: "team@acme.com" },
  },
  {
    title: "Storage almost full",
    variant: "warn",
    options: { description: "4.6 GB of 5 GB used" },
  },
  {
    title: "Couldn't reach the calendar server",
    variant: "error",
    options: { description: "We'll retry in 30 seconds." },
  },
];

function $stage(heightPx: number): HTMLElement {
  return Div.make().assignStyles({
    position: "relative",
    width: "100%",
    height: `${heightPx}px`,
    overflow: "hidden",
    transform: "translateZ(0)",
    containerType: "inline-size",
    boxSizing: "border-box",
    background: "var(--bg)",
    border: "1px solid var(--divider)",
    borderRadius: "12px",
  });
}

function $stagedToaster($stage: HTMLElement): Toaster {
  const $toaster = Toaster.make();
  $toaster.assignStyles({
    "--toaster-offset": STAGE_INSET,
    // The page's own persistent container publishes its height on <body>;
    // this stage has none, so it must not inherit that lift.
    "--persistent-toast-height": "0px",
  });
  $stage.appendChild($toaster);
  return $toaster;
}

function $stagedContainer($stage: HTMLElement): Toaster.Persistent.Container {
  const $container = Toaster.Persistent.Container.make();
  $container.style.setProperty("--toaster-offset", STAGE_INSET);
  $stage.appendChild($container);
  return $container;
}

// The toaster measures and caches each toast's height when it is shown. A
// toast shown before the card is in the document caches 0px and the expanded
// layout piles every toast onto one line, so seed stacks once attached.
function whenConnected($e: HTMLElement, fn: EmptyFunction, framesLeft = 600) {
  if ($e.isConnected) {
    fn();
    return;
  }
  if (framesLeft === 0) return;
  requestAnimationFrame(() => whenConnected($e, fn, framesLeft - 1));
}

// Toasts are the toaster's light-DOM children, so a count is one observer.
function trackCount(
  $toaster: Toaster,
  onCount: (count: number) => void,
): void {
  new MutationObserver(() => onCount($toaster.childElementCount)).observe(
    $toaster,
    { childList: true },
  );
}

function $statusLine(text: string): Storybook.Card.StatusLine {
  const $status = Storybook.Card.StatusLine.make();
  $status.style.minHeight = "unset";
  $status.bindText(text);
  return $status;
}

export class CoreToasterStoryBook extends Storybook.Default {
  title(): string {
    return "Toaster";
  }

  tags(): string[] {
    return ["std-toaster"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "A stack of three — hover it to fan out and reveal Clear all",
        render: () => {
          const $content = $stage(360);
          const $toaster = $stagedToaster($content);
          let next = 0;
          const add = (timeoutMs: number) => {
            const props = NOTIFICATIONS[next % NOTIFICATIONS.length]!;
            next++;
            $toaster.show(Toast.makeWith(props), timeoutMs);
          };

          whenConnected($content, () => {
            add(STAY_MS);
            add(STAY_MS);
            add(STAY_MS);
          });

          const $controls = Storybook.Card.Controls.make();
          $controls.append(
            Button.makeWith("Add one", {
              type: "primary",
              onClick: () => add(4_000),
            }),
            Button.makeWith("Dismiss all", {
              type: "secondary",
              onClick: () => $toaster.dismissAll(),
            }),
          );
          return { $content, $controls };
        },
      },
      {
        // The toaster runs one clock: the front (newest) toast's. When it
        // expires the next toast becomes the front and starts its own full
        // duration, so a burst leaves newest-first, one at a time.
        title: "Timeouts run newest-first; hovering the stack pauses them",
        render: () => {
          const $content = $stage(240);
          const $toaster = $stagedToaster($content);
          const $status = $statusLine("Nothing on screen");
          trackCount($toaster, (count) => {
            $status.bindText(
              count === 0 ? "Nothing on screen" : `${count} on screen`,
            );
          });

          const $controls = Storybook.Card.Controls.make();
          $controls.append(
            Button.makeWith("Show three, 2 s each", {
              type: "primary",
              onClick: () => {
                for (const step of [1, 2, 3]) {
                  $toaster.show(
                    Toast.makeWith({ title: `Uploaded photo ${step} of 3` }),
                    2_000,
                  );
                }
              },
            }),
          );
          return { $content, $controls, $status };
        },
      },
      {
        // Expanded, the stack is a fixed 300px window. Older toasts that
        // fall off the top stick to its edge, shrink and blur; the wheel
        // scrolls back through them.
        title: "An expanded stack taller than 300px scrolls with the wheel",
        render: () => {
          const $content = $stage(360);
          const $toaster = $stagedToaster($content);
          const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
          whenConnected($content, () => {
            for (const [index, day] of days.entries()) {
              $toaster.show(
                Toast.makeWith({
                  title: `Daily summary · ${day}`,
                  options: {
                    description: `${3 + index} events, ${index} tasks completed`,
                  },
                }),
                STAY_MS,
              );
            }
          });
          return $content;
        },
      },
      {
        // The toaster wires each toast's Undo and close to remove just that
        // toast; the caller's undo callback runs first.
        title: "Undo or close removes one toast and the rest restack",
        render: () => {
          const $content = $stage(260);
          const $toaster = $stagedToaster($content);
          const $status = $statusLine("Deleted three events");
          const remove = (name: string) => {
            $toaster.show(
              Toast.makeWith({
                title: `Deleted “${name}”`,
                options: {
                  undo: () => $status.bindText(`Restored “${name}”`),
                },
              }),
              STAY_MS,
            );
          };

          whenConnected($content, () => {
            remove("Standup");
            remove("1:1 with Priya");
            remove("Gym");
          });

          const $controls = Storybook.Card.Controls.make();
          $controls.append(
            Button.makeWith("Delete another", {
              type: "secondary",
              onClick: () => remove("Lunch"),
            }),
          );
          return { $content, $controls, $status };
        },
      },
    ];
  }
}

export class CoreToasterPersistentContainerStoryBook extends Storybook.Default {
  title(): string {
    return "Toaster Persistent Container";
  }

  tags(): string[] {
    return ["std-toaster-persistent-container"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        // The is-online pattern: no timeout and no close button; the caller
        // keeps the handle and dismisses when the condition clears.
        title: "An offline banner stays until its caller dismisses it",
        render: () => {
          const $content = $stage(140);
          const $container = $stagedContainer($content);
          let handle: Option<Toaster.Persistent.Handle>;
          const $toggle = Button.makeWith("Go online", {
            type: "secondary",
            onClick: () => setOffline(handle == null),
          });
          const setOffline = (offline: boolean) => {
            if (offline) {
              handle ??= $container.show(
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
                  options: { showClose: false },
                }),
              );
            } else {
              handle?.dismiss();
              handle = null;
            }
            $toggle.textContent = offline ? "Go online" : "Go offline";
          };
          setOffline(true);

          const $controls = Storybook.Card.Controls.make();
          $controls.append($toggle);
          return { $content, $controls };
        },
      },
      {
        // How the sheet's tips share the corner: one group, one visible
        // member, page dots once there are two or more. Dismissing the
        // visible member reveals its neighbour.
        title: "Grouped tips share one slot; the dots page between them",
        render: () => {
          const $content = $stage(200);
          const $container = $stagedContainer($content);
          const $status = $statusLine("");
          const tips = [
            {
              title: "Day view follows you",
              description: "Times shift to the timezone you're travelling in.",
            },
            {
              title: "Switch event calendars",
              description: "Month view can show one calendar at a time.",
            },
            {
              title: "Reconnect Whoop",
              description: "Your sleep data stopped syncing yesterday.",
            },
          ];
          let open = 0;
          const report = () => {
            $status.bindText(
              open === 0
                ? "No tips showing"
                : `${open} of ${tips.length} tips in the group`,
            );
          };
          const showAll = () => {
            if (open > 0) return;
            for (const [index, { title, description }] of tips.entries()) {
              let handle: Option<Toaster.Persistent.Handle> = $container.show(
                `tip-${index}`,
                Toast.makeWith({
                  title,
                  options: { description, showClose: false },
                  cta: {
                    label: "Got it",
                    fn: () => {
                      if (!handle) return;
                      handle.dismiss();
                      handle = null;
                      open--;
                      report();
                    },
                  },
                }),
                "sheet-tips",
              );
              open++;
            }
            report();
          };
          showAll();

          const $controls = Storybook.Card.Controls.make();
          $controls.append(
            Button.makeWith("Show the tips again", {
              type: "secondary",
              onClick: showAll,
            }),
          );
          return { $content, $controls, $status };
        },
      },
      {
        title: "Ungrouped banners stack in arrival order, newest at the bottom",
        render: () => {
          const $content = $stage(220);
          const $container = $stagedContainer($content);
          const handles: Toaster.Persistent.Handle[] = [];
          const banners: Toast.Props[] = [
            {
              title: "Update available",
              options: {
                description: "Restart to finish installing 0.1.56.",
                showClose: false,
              },
            },
            {
              title: "Sync paused",
              variant: "warn",
              options: { description: "Battery saver is on." },
            },
          ];
          const showAll = () => {
            if (handles.length > 0) return;
            for (const [index, props] of banners.entries()) {
              handles.push(
                $container.show(`banner-${index}`, Toast.makeWith(props)),
              );
            }
          };
          showAll();

          const $controls = Storybook.Card.Controls.make();
          $controls.append(
            Button.makeWith("Dismiss oldest", {
              type: "secondary",
              onClick: () => handles.shift()?.dismiss(),
            }),
            Button.makeWith("Reset", {
              type: "flat",
              onClick: () => {
                for (const handle of handles.splice(0)) handle.dismiss();
                showAll();
              },
            }),
          );
          return { $content, $controls };
        },
      },
      {
        // The container publishes its height as --persistent-toast-height on
        // its parent, this stage, and the stage's toaster lifts its stack by
        // that much.
        title: "Transient toasts rise above the persistent banner",
        render: () => {
          const $content = $stage(280);
          const $container = $stagedContainer($content);
          const $toaster = Toaster.make();
          $toaster.style.setProperty("--toaster-offset", STAGE_INSET);
          $content.appendChild($toaster);
          let banner: Option<Toaster.Persistent.Handle>;
          const toggleBanner = () => {
            if (banner) {
              banner.dismiss();
              banner = null;
              return;
            }
            banner = $container.show(
              "reconnecting",
              Toast.makeWith({
                title: "Reconnecting…",
                options: {
                  description: "Edits are saved on this device.",
                  showClose: false,
                },
              }),
            );
          };
          toggleBanner();

          const $controls = Storybook.Card.Controls.make();
          $controls.append(
            Button.makeWith("Show a toast", {
              type: "primary",
              onClick: () => {
                $toaster.show(
                  Toast.makeWith({ title: "Copied link to “Q4 roadmap”" }),
                  3_000,
                );
              },
            }),
            Button.makeWith("Toggle banner", {
              type: "secondary",
              onClick: toggleBanner,
            }),
          );
          return { $content, $controls };
        },
      },
    ];
  }
}

import { LonaIcons } from "../../ui/icons";
import { CalendarIcon, CircleIcon, GearIcon } from "../../ui/icons";
import { Storybook } from "../../ui/storybook";
import { PillButton } from "../pill-button";
import { Toast } from "../toast/toast";
import { PropertyList, PropertyListItem } from "./property-list";

export class PropertyListStoryBook extends Storybook.Default {
  title(): string {
    return "Property List";
  }

  tags(): string[] {
    return ["std-property-list", "std-property-list-item"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Basic Property List",
        render: () => {
          const $container = PropertyList.make();

          const $prop1 = PropertyListItem.make();
          $prop1.bind({ label: "Status", value: "Active" });

          const $prop2 = PropertyListItem.make();
          $prop2.bind({ label: "Count", value: "42" });

          const $prop3 = PropertyListItem.make();
          $prop3.bind({ label: "Location", value: "San Francisco, CA" });

          $container.appendChild($prop1);
          $container.appendChild($prop2);
          $container.appendChild($prop3);

          return $container.assignStyles({
            width: "100%",
          });
        },
      },
      {
        title: "With Number Input",
        render: () => {
          const $container = PropertyList.make();

          const $prop1 = PropertyListItem.make();
          $prop1.bindLabel("Editable Value");
          const $numberInput = PropertyListItem.makeNumberInput({
            initialValue: 100,
            onEditingFinished: (n) => {
              Toast.info(`Value changed to: ${n ?? "empty"}`);
            },
            editable: true,
          });
          $prop1.appendChild($numberInput);

          const $prop2 = PropertyListItem.make();
          $prop2.bindLabel("Read-only Value");
          const $readOnlyInput = PropertyListItem.makeNumberInput({
            initialValue: 50,
            onEditingFinished: () => {},
            editable: false,
          });
          $prop2.appendChild($readOnlyInput);

          $container.appendChild($prop1);
          $container.appendChild($prop2);

          return $container.assignStyles({
            width: "100%",
          });
        },
      },
      {
        title: "Display + Stacked (read-only)",
        render: () => {
          const $container = PropertyList.make();
          $container.toggleAttribute("flat", true);
          $container.style.setProperty("--label-min-width", "96px");
          $container.appendChild(
            PropertyListItem.Display({ label: "Advertiser", value: "Motion — AI Calendar" }),
          );
          $container.appendChild(
            PropertyListItem.Display({ label: "Status", value: "Active" }),
          );
          $container.appendChild(
            PropertyListItem.Display({ label: "Started", value: "Mar 12, 2026" }),
          );
          $container.appendChild(
            PropertyListItem.Stacked({
              label: "Summary",
              value:
                "Strong problem-first hook paired with a real product " +
                "screenshot; the offer is the weak leg — the trial terms " +
                "stop short of pricing.",
            }),
          );
          return $container.assignStyles({
            width: "100%",
          });
        },
      },
      {
        title: "Custom Slot Content",
        render: () => {
          const $container = PropertyList.make();
          const $plist = PropertyListItem.make();
          $plist.bind({
            label: "Custom Widget",
            value: PillButton.makeWith("Tag"),
          });
          $container.appendChild($plist);
          return $container.assignStyles({
            width: "100%",
          });
        },
      },
      {
        title: "With Icons & Label Width",
        render: () => {
          const $container = PropertyList.make();
          $container.style.setProperty("--label-min-width", "120px");

          const $prop1 = PropertyListItem.make();
          $prop1.bind({
            label: "Status",
            value: "Active",
            icon: LonaIcons.$svg(CircleIcon),
            onLabelClick: () => Toast.info("Status label clicked"),
          });

          const $prop2 = PropertyListItem.make();
          $prop2.bind({
            label: "Due date",
            value: "Tomorrow",
            icon: LonaIcons.$svg(CalendarIcon),
            onLabelClick: () => Toast.info("Due date label clicked"),
          });

          const $prop3 = PropertyListItem.make();
          $prop3.bind({
            label: "Settings",
            value: "Default",
            icon: LonaIcons.$svg(GearIcon),
          });

          $container.appendChild($prop1);
          $container.appendChild($prop2);
          $container.appendChild($prop3);

          return $container.assignStyles({
            width: "100%",
          });
        },
      },
    ];
  }
}

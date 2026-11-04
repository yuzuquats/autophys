import arrowsAngleExpandIcon from "@tento-ui/icons/arrows-angle-expand.svg";
import arrowsFullScreenIcon from "@tento-ui/icons/arrows-full-screen.svg";
import calendarRangeIcon from "@tento-ui/icons/calendar-range.svg";
import carFrontIcon from "@tento-ui/icons/car-front.svg";
import checkIcon from "@tento-ui/icons/check.svg";
import checkCircleIcon from "@tento-ui/icons/check-circle.svg";
import cloudDrizzleIcon from "@tento-ui/icons/cloud-drizzle.svg";
import expandArrowsVerticalIcon from "@tento-ui/icons/expand-arrows-vertical.svg";
import eyeIcon from "@tento-ui/icons/eye.svg";
import eyeSlashedIcon from "@tento-ui/icons/eye-slashed.svg";
import graphIcon from "@tento-ui/icons/graph.svg";
import gridIcon from "@tento-ui/icons/grid.svg";
import hashIcon from "@tento-ui/icons/hash.svg";
import journalIcon from "@tento-ui/icons/journal.svg";
import listUlIcon from "@tento-ui/icons/list-ul.svg";
import searchIcon from "@tento-ui/icons/search.svg";
import snapRightIcon from "@tento-ui/icons/snap-right.svg";
import starFilledIcon from "@tento-ui/icons/star-filled.svg";
import starOutlineIcon from "@tento-ui/icons/star-outline.svg";
import priorityHighIcon from "@tento-ui/icons/priority-high.svg";
import priorityMediumIcon from "@tento-ui/icons/priority-medium.svg";
import priorityLowIcon from "@tento-ui/icons/priority-low.svg";
import statusCompletedIcon from "@tento-ui/icons/status-completed.svg";
import statusInProgressIcon from "@tento-ui/icons/status-in-progress.svg";
import statusPlannedIcon from "@tento-ui/icons/status-planned.svg";
import statusScheduledIcon from "@tento-ui/icons/status-scheduled.svg";
import playFillIcon from "@tento-ui/icons/bootstrap/play-fill.svg";
import { Storybook } from "../ui/storybook";
import {
  AngleRightIcon,
  ArrowBackIcon,
  ArrowDownIcon,
  ArrowsAngleExpandIcon,
  ArrowsVerticalIcon,
  BarChartIcon,
  CalendarIcon,
  CardTextIcon,
  CheckCircleFilledIcon,
  CheckmarkIcon,
  CheckSquareIcon,
  CircleIcon,
  ClockIcon,
  CloudIcon,
  CollapseIcon,
  DragIcon,
  ExpandIcon,
  FormulaIcon,
  GearIcon,
  GridIcon,
  HashIcon,
  JournalIcon,
  LinkIcon,
  ListNestedIcon,
  LoadingIcon,
  LonaIcons,
  MoonFillIcon,
  MoonIcon,
  NumberIcon,
  PencilFilledIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  ResetIcon,
  SearchIcon,
  SnapCenterIcon,
  SnapLeftIcon,
  SparkleIcon,
  Text2Icon,
  TextCenter,
  TextIcon,
  TextLeft,
  TextRight,
  ThreeDotsIcon,
  TrashIcon,
  WifiIcon,
  XIcon,
  ShuffleIcon,
} from "./icons";
import { $jsx } from "./jsx";

const ALL_ICONS: { icon: string; name: string }[] = [
  { icon: AngleRightIcon, name: "AngleRightIcon" },
  { icon: ArrowBackIcon, name: "ArrowBackIcon" },
  { icon: ArrowDownIcon, name: "ArrowDownIcon" },
  { icon: ArrowsAngleExpandIcon, name: "ArrowsAngleExpandIcon" },
  { icon: arrowsAngleExpandIcon, name: "arrowsAngleExpandIcon" },
  { icon: arrowsFullScreenIcon, name: "arrowsFullScreenIcon" },
  { icon: ArrowsVerticalIcon, name: "ArrowsVerticalIcon" },
  { icon: BarChartIcon, name: "BarChartIcon" },
  { icon: CalendarIcon, name: "CalendarIcon" },
  { icon: calendarRangeIcon, name: "calendarRangeIcon" },
  { icon: CardTextIcon, name: "CardTextIcon" },
  { icon: carFrontIcon, name: "carFrontIcon" },
  { icon: CheckCircleFilledIcon, name: "CheckCircleFilledIcon" },
  { icon: checkCircleIcon, name: "checkCircleIcon" },
  { icon: checkIcon, name: "checkIcon" },
  { icon: CheckmarkIcon, name: "CheckmarkIcon" },
  { icon: CheckSquareIcon, name: "CheckSquareIcon" },
  { icon: CircleIcon, name: "CircleIcon" },
  { icon: ClockIcon, name: "ClockIcon" },
  { icon: cloudDrizzleIcon, name: "cloudDrizzleIcon" },
  { icon: CloudIcon, name: "CloudIcon" },
  { icon: CollapseIcon, name: "CollapseIcon" },
  { icon: DragIcon, name: "DragIcon" },
  { icon: ExpandIcon, name: "ExpandIcon" },
  { icon: expandArrowsVerticalIcon, name: "expandArrowsVerticalIcon" },
  { icon: eyeIcon, name: "eyeIcon" },
  { icon: eyeSlashedIcon, name: "eyeSlashedIcon" },
  { icon: FormulaIcon, name: "FormulaIcon" },
  { icon: GearIcon, name: "GearIcon" },
  { icon: graphIcon, name: "graphIcon" },
  { icon: GridIcon, name: "GridIcon" },
  { icon: gridIcon, name: "gridIcon" },
  { icon: HashIcon, name: "HashIcon" },
  { icon: hashIcon, name: "hashIcon" },
  { icon: JournalIcon, name: "JournalIcon" },
  { icon: journalIcon, name: "journalIcon" },
  { icon: LinkIcon, name: "LinkIcon" },
  { icon: ListNestedIcon, name: "ListNestedIcon" },
  { icon: listUlIcon, name: "listUlIcon" },
  { icon: LoadingIcon, name: "LoadingIcon" },
  { icon: MoonFillIcon, name: "MoonFillIcon" },
  { icon: MoonIcon, name: "MoonIcon" },
  { icon: NumberIcon, name: "NumberIcon" },
  { icon: PencilFilledIcon, name: "PencilFilledIcon" },
  { icon: PencilIcon, name: "PencilIcon" },
  { icon: playFillIcon, name: "playFillIcon" },
  { icon: PlayIcon, name: "PlayIcon" },
  { icon: PlusIcon, name: "PlusIcon" },
  { icon: priorityHighIcon, name: "priorityHighIcon" },
  { icon: priorityLowIcon, name: "priorityLowIcon" },
  { icon: priorityMediumIcon, name: "priorityMediumIcon" },
  { icon: ResetIcon, name: "ResetIcon" },
  { icon: SearchIcon, name: "SearchIcon" },
  { icon: searchIcon, name: "searchIcon" },
  { icon: SnapCenterIcon, name: "SnapCenterIcon" },
  { icon: SnapLeftIcon, name: "SnapLeftIcon" },
  { icon: snapRightIcon, name: "snapRightIcon" },
  { icon: SparkleIcon, name: "SparkleIcon" },
  { icon: starFilledIcon, name: "starFilledIcon" },
  { icon: starOutlineIcon, name: "starOutlineIcon" },
  { icon: statusCompletedIcon, name: "statusCompletedIcon" },
  { icon: statusInProgressIcon, name: "statusInProgressIcon" },
  { icon: statusPlannedIcon, name: "statusPlannedIcon" },
  { icon: statusScheduledIcon, name: "statusScheduledIcon" },
  { icon: Text2Icon, name: "Text2Icon" },
  { icon: TextCenter, name: "TextCenter" },
  { icon: TextIcon, name: "TextIcon" },
  { icon: TextLeft, name: "TextLeft" },
  { icon: TextRight, name: "TextRight" },
  { icon: ThreeDotsIcon, name: "ThreeDotsIcon" },
  { icon: TrashIcon, name: "TrashIcon" },
  { icon: WifiIcon, name: "WifiIcon" },
  { icon: XIcon, name: "XIcon" },
  { icon: ShuffleIcon, name: "ShuffleIcon" },
];

export class IconsStoryBook extends Storybook.Default {
  title(): string {
    return "Icons";
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.style.minHeight = "unset";
          $status.bindText("Hover over an icon");

          const $container = $jsx("std-row", {
            style: {
              maxWidth: "360px",
              flexWrap: "wrap",
            },
          });

          for (const { icon, name } of ALL_ICONS) {
            const $icon = LonaIcons.make(icon, {
              sizePx: 24,
            }).assignStyles({
              margin: "4px",
              background: "var(--bg-surface-light)",
              borderRadius: "4px",
              cursor: "pointer",
            });

            $icon.addEventListener("mouseenter", () => {
              $status.bindText(name);
            });
            $icon.addEventListener("mouseleave", () => {
              $status.bindText("Hover over an icon");
            });

            $container.appendChild($icon);
          }

          return {
            $content: $container,
            $status,
          };
        },
      },
    ];
  }
}

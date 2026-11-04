import { Storybook } from "@tento-ui/ui/storybook";
import { PlanSelector } from "./plan-selector";
import { Toast } from "../../components/toast/toast";
import { BrowserChrome } from "../../components/browser-chrome";

const MOCK_PLANS: PlanSelector.Plan[] = [
  {
    id: "Trial",
    title: "Contact Us",
    caption: "Need something custom? We're here to help",
    tier: 0,
    features: ["Custom solutions", "Enterprise support", "Dedicated account manager"],
  },
  {
    id: "Pro",
    title: "Professional",
    caption: "Best for individuals looking to organize and schedule events",
    tag: "Most popular",
    tier: 1,
    priceUsdPerMonth: 9.99,
    priceUsdPerMonthAnnual: 8.49,
    features: [
      "Unlimited sheets",
      "Advanced calendar functionality",
      "Daily task planner",
      "Scheduling links",
    ],
  },
  {
    id: "Teams",
    title: "Teams",
    caption:
      "Best for teams who would like to share and organize sheets together",
    tier: 2,
    priceUsdPerMonth: 19.99,
    priceUsdPerMonthAnnual: 16.99,
    features: [
      "Everything on Professional",
      "Collaborative sheets and sharing",
    ],
  },
];

export class PlanSelectorStoryBook extends Storybook.Default {
  title(): string {
    return "Plan Selector";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Plan Selector",
        render: () =>
          BrowserChrome.makeExample(
            PlanSelector.makeWith({
              plans: MOCK_PLANS,
              activeProduct: "Pro",
              onPlanSelect: (plan, isYearly) => {
                Toast.info(`Selected plan: ${plan.id}, isYearly: ${isYearly}`);
              },
              onRedeemKey: (code) => {
                Toast.info(`Redeeming key: ${code}`);
              },
              onContactUs: () => {
                window.location.href = "mailto:james@lona.so";
              },
            }),
            "ui.lona.so/plans",
            1200,
          ).assignStyles({
            alignSelf: "stretch",
            width: "100%",
          }),
      },
      {
        title: "Plan Selector (No Active Plan)",
        render: () =>
          PlanSelector.makeWith({
            plans: MOCK_PLANS,
            onPlanSelect: (plan, isYearly) => {
              Toast.info(`Selected plan: ${plan.id}, isYearly: ${isYearly}`);
            },
            onRedeemKey: (code) => {
              Toast.info(`Redeeming key: ${code}`);
            },
            onContactUs: () => {
              window.location.href = "mailto:james@lona.so";
            },
          }).assignStyles({
            alignSelf: "stretch",
            width: "100%",
          }),
      },
    ];
  }
}

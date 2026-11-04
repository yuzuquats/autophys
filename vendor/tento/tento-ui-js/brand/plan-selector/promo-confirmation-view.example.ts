import { Storybook } from "../../ui/storybook";
import { Toast } from "../../components/toast/toast";
import { BrowserChrome } from "../../components/browser-chrome";
import { Transition } from "../../components/transition";
import { PromoConfirmationView } from "./promo-confirmation-view";
import { PlanSelector } from "./plan-selector";

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

export class PromoConfirmationViewStoryBook extends Storybook.Default {
  title(): string {
    return "Promo Confirmation View";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Promo Confirmation (Pro — 30 day)",
        render: () => {
          const $transition = Transition.make();

          const $promoView = PromoConfirmationView.makeWith({
            promoCode: "FRIEND2024",
            grantedPlan: "Professional",
            description: "You've unlocked Professional access with a 30-day free trial. Start organizing your schedule with advanced calendar functionality and scheduling links.",
            onChooseAnother: () => {
              $transition.bindState("after");
            },
          });

          const $planSelector = PlanSelector.makeWith({
            plans: MOCK_PLANS,
            onPlanSelect: (plan, isYearly) => {
              Toast.info(`Selected: ${plan.id}, yearly: ${isYearly}`);
            },
          });

          $transition.bind({
            state: "before",
            $before: $promoView,
            $after: $planSelector,
          });

          $transition.setAttribute("height", "max-content");

          return BrowserChrome.makeExample(
            $transition,
            "calendar.lona.so/onboarding",
            1200,
          ).assignStyles({
            alignSelf: "stretch",
            width: "100%",
          });
        },
      },
      {
        title: "Promo Confirmation (Pro — indeterminate)",
        render: () =>
          PromoConfirmationView.makeWith({
            promoCode: "LIFETIME_PRO",
            grantedPlan: "Professional",
            description: "You've unlocked Professional access. Start organizing your schedule with advanced calendar functionality and scheduling links.",
            onChooseAnother: () => {
              Toast.info("Choose another option clicked");
            },
          }).assignStyles({
            alignSelf: "stretch",
            width: "100%",
          }),
      },
      {
        title: "Promo Confirmation (Teams — 90 day)",
        render: () =>
          PromoConfirmationView.makeWith({
            promoCode: "TEAM_PROMO",
            grantedPlan: "Teams",
            description: "You've unlocked Teams access with a 90-day free trial. Collaborate with your team using shared sheets and advanced organizational tools.",
            onChooseAnother: () => {
              Toast.info("Choose another option clicked");
            },
          }).assignStyles({
            alignSelf: "stretch",
            width: "100%",
          }),
      },
    ];
  }
}

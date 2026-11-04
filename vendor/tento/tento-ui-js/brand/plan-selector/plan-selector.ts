import { PlanControls } from "./plan-controls";
import "@tento-ui/components/button-group-row";
import "@tento-ui/components/button/button";
import "@tento-ui/components/editable-text";

import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Div } from "../../component-builtin";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { Button } from "../../components/button/button";
import { ButtonGroupRow } from "../../components/button-group-row";
import { EditableText } from "../../components/editable-text";
import { Overlay } from "../../components/overlay";
import { Round } from "../../components/round";

@component({
  name: "std-plan-selector",
})
export class PlanSelector extends LonaWebComponent {
  private plans: PlanSelector.Plan[] = [];
  private activeProduct: Option<string> = undefined;
  private isPromoProduct: boolean = false;
  private isPaymentsTesting: boolean = false;
  private prefilledPromoCode: Option<string> = undefined;
  private onPlanSelect?: (plan: PlanSelector.Plan, isYearly: boolean) => void;
  private onCurrentPlanManage?: (plan: PlanSelector.Plan) => void;
  private onRedeemKey?: (code: string) => void;
  private onContactUs?: () => void;
  private onViewPromo?: () => void;

  static makeWith(props: PlanSelector.Props): PlanSelector {
    return PlanSelector.make().bind(props);
  }

  bind(props: PlanSelector.Props): this {
    this.plans = props.plans ?? [];
    this.activeProduct = props.activeProduct;
    this.isPromoProduct = props.isPromoProduct ?? false;
    this.isPaymentsTesting = props.isPaymentsTesting ?? false;
    this.prefilledPromoCode = props.prefilledPromoCode;
    this.onPlanSelect = props.onPlanSelect;
    this.onCurrentPlanManage = props.onCurrentPlanManage;
    this.onRedeemKey = props.onRedeemKey;
    this.onContactUs = props.onContactUs;
    this.onViewPromo = props.onViewPromo;
    this.renderPlans();
    return this;
  }

  private renderPlans(): void {
    const $plansContainer = this.$("plans");
    DomUtils.clearChildren($plansContainer);

    // Find the tier of the user's active plan
    const activePlan = this.plans.find((p) => p.id === this.activeProduct);
    const activePlanTier = activePlan?.tier ?? 0;

    for (const plan of this.plans) {
      const $planCard = PlanCard.makeWith({
        plan,
        isActive: this.activeProduct === plan.id,
        isPromoProduct: this.isPromoProduct && this.activeProduct === plan.id,
        activePlanTier,
        isPaymentsTesting: this.isPaymentsTesting,
        prefilledPromoCode: this.prefilledPromoCode,
        onSelect: (selectedPlan, isYearly) => {
          this.onPlanSelect?.(selectedPlan, isYearly);
        },
        onManage: (selectedPlan) => {
          this.onCurrentPlanManage?.(selectedPlan);
        },
        onRedeemKey: this.onRedeemKey,
        onContactUs: this.onContactUs,
        // Only offer the "view promo" affordance when a promo is actually the
        // active product's source; otherwise the Contact Us card would render
        // "← Promo Applied" for every user, even those with no promo applied.
        onViewPromo: this.isPromoProduct ? this.onViewPromo : undefined,
      });
      $plansContainer.appendChild($planCard);
    }
  }

  static $styles = [
    css`
      :host {
        display: flex;
        flex-grow: 1;
        container-type: inline-size;
      }

      #plans {
        border-radius: 8px;
        border: 1px solid var(--divider);
        overflow: hidden;
        height: 100%;
        flex-grow: 1;
      }

      std-plan-card {
        flex: 1;
        position: relative;
        min-height: 480px;
      }

      @container (width < 800px) {
        #plans {
          flex-direction: column;
          --title-height: none;
        }

        std-plan-card {
          min-height: 200px;
          flex: unset;
        }

        std-plan-card:not(:last-child) {
          border-bottom: 1px solid var(--divider);
        }

        std-plan-card:not(:last-child)::after {
          display: none;
        }
      }

      std-plan-card:not(:last-child)::after {
        content: "";
        position: absolute;
        right: -0.5px;
        top: 0px;
        width: 1px;
        height: 100%;
        background: var(--divider);
      }
    `,
  ];

  static $html = html`
    <std-row id="plans"></std-row>
  `;
}

@component({
  name: "std-plan-card",
})
export class PlanCard extends LonaWebComponent {
  private $annualToggle: ButtonGroupRow<"annual" | "monthly"> =
    this.hydrate("annual-toggle");
  private plan: Option<PlanSelector.Plan> = undefined;
  private isActive: boolean = false;
  private isPromoProduct: boolean = false;
  private activePlanTier: number = 0;
  private priceType: "annual" | "monthly" = "annual";
  private prefilledPromoCode: Option<string> = undefined;
  private onSelect?: (plan: PlanSelector.Plan, isYearly: boolean) => void;
  private onManage?: (plan: PlanSelector.Plan) => void;
  private onRedeemKey?: (code: string) => void;
  private onContactUs?: () => void;
  private onViewPromo?: () => void;

  static makeWith(props: PlanCard.Props): PlanCard {
    return PlanCard.make().bind(props);
  }

  bind(props: PlanCard.Props): this {
    this.plan = props.plan;
    this.isActive = props.isActive ?? false;
    this.isPromoProduct = props.isPromoProduct ?? false;
    this.activePlanTier = props.activePlanTier ?? 0;
    this.prefilledPromoCode = props.prefilledPromoCode;
    this.onSelect = props.onSelect;
    this.onManage = props.onManage;
    this.onRedeemKey = props.onRedeemKey;
    this.onContactUs = props.onContactUs;
    this.onViewPromo = props.onViewPromo;

    this.renderPlan();
    return this;
  }

  private renderPlan(): void {
    if (!this.plan) return;

    const plan = this.plan;

    // Set title and caption
    this.$("title").textContent = plan.title;
    this.$("caption").textContent = plan.caption;
    this.$("title-tag").textContent = plan.tag ?? "";

    this.configureCTA();
    this.configurePricing();
    this.renderFeatures();
    this.configureCTAHandler();
  }

  private configureCTA(): void {
    if (!this.plan) return;

    const $cta = this.$("cta");
    const $redeemKeyLink = this.$("redeem-key-link");
    PlanControls.button.bind($cta as HTMLButtonElement, { text: $cta.textContent ?? "", variant: "default", plan: true });
    this.bindAction(this.$("promo-applied-label"));
    this.bindAction(this.$("change-promo-link"));

    // Handle Trial plan as "Contact Us" section - show promotion key link
    if (this.plan.id === "Trial") {
      $cta.textContent = "Contact Us";
      $cta.toggleAttribute("primary", true);
      $cta.toggleAttribute("disabled", false);

      // Reset promo affordances first. This card is pooled/recycled, so a prior
      // promo-active render could otherwise leave the "Promo Applied" row or the
      // prefilled indicator visible on a card that no longer has a promo.
      const $viewPromoRow = this.$("view-promo-row");
      $viewPromoRow.style.display = "none";
      $redeemKeyLink.classList.remove("prefilled");
      $redeemKeyLink.textContent = "Add promotion key";
      $redeemKeyLink.style.display = "block";

      if (this.onViewPromo) {
        $redeemKeyLink.style.display = "none";
        $viewPromoRow.style.display = "";
        this.bindAction(this.$("promo-applied-label"), () => this.onViewPromo?.());
        this.bindAction(this.$("change-promo-link"), () => this.showRedeemKeyPrompt());
      } else if (this.prefilledPromoCode) {
        // Show prefilled indicator instead of clickable link
        $redeemKeyLink.textContent = `Promo: ${this.prefilledPromoCode}`;
        $redeemKeyLink.classList.add("prefilled");
      } else if (this.onRedeemKey) {
        $redeemKeyLink.style.display = "block";
      } else {
        $redeemKeyLink.style.display = "none";
      }
      return;
    }

    // Hide promotion key link for other plans
    $redeemKeyLink.style.display = "none";

    if (this.isActive && this.isPromoProduct) {
      $cta.textContent = "View promo";
      $cta.toggleAttribute("primary", false);
      $cta.toggleAttribute("secondary", true);
      $cta.toggleAttribute("disabled", false);
    } else if (this.isActive) {
      $cta.textContent = "Manage";
      $cta.toggleAttribute("primary", false);
      $cta.toggleAttribute("secondary", true);
      $cta.toggleAttribute("disabled", false);
    } else if (this.plan.tier < this.getCurrentPlanTier()) {
      $cta.textContent = "Downgrade";
      $cta.toggleAttribute("primary", false);
      $cta.toggleAttribute("secondary", false);
      $cta.toggleAttribute("disabled", true);
    } else {
      $cta.textContent = "Upgrade";
      $cta.toggleAttribute("primary", true);
      $cta.toggleAttribute("secondary", false);
      $cta.toggleAttribute("disabled", false);
    }
  }

  private configurePricing(): void {
    if (!this.plan) return;

    const $pricing = this.$("pricing");
    const hasMonthlyPrice = this.plan.priceUsdPerMonth != null;
    const hasAnnualDiscount = this.plan.priceUsdPerMonthAnnual != null;

    $pricing.style.display = hasMonthlyPrice ? "flex" : "none";
    this.$annualToggle.style.display = hasAnnualDiscount ? "flex" : "none";

    if (!hasAnnualDiscount) return;

    this.bindPrice();
    PlanControls.billingCycle.bind(this.$annualToggle, "annual");
    this.$annualToggle.onSelected = (type) => {
      this.priceType = type;
      this.bindPrice();
    };
  }

  private bindPrice(): void {
    if (!this.plan) return;

    const $price = this.$("price");
    const $pricePeriod = this.$("price-period");

    if (
      this.priceType === "annual" &&
      this.plan.priceUsdPerMonthAnnual != null
    ) {
      $price.textContent = "$" + this.plan.priceUsdPerMonthAnnual;
    } else if (this.plan.priceUsdPerMonth != null) {
      $price.textContent = "$" + this.plan.priceUsdPerMonth;
    }
    $pricePeriod.textContent = "mo";
  }

  private renderFeatures(): void {
    if (!this.plan) return;

    const $features = this.$("features");
    DomUtils.clearChildren($features);

    for (const feature of this.plan.features) {
      $features.appendChild(Typography.p(feature));
    }
  }

  private configureCTAHandler(): void {
    if (!this.plan) return;

    const $cta = this.$("cta");
    const $redeemKeyLink = this.$("redeem-key-link");

    const canRedeem = this.plan.id === "Trial" && !!this.onRedeemKey && !this.prefilledPromoCode && !this.onViewPromo;
    this.bindAction($redeemKeyLink, canRedeem ? () => this.showRedeemKeyPrompt() : undefined);

    GESTURE_MANAGER.unregister($cta);
    $cta.onclick = () => {
      if (!this.plan || $cta.hasAttribute("disabled")) return;
      if (this.plan.id === "Trial") this.onContactUs?.();
      else if (this.isActive && this.isPromoProduct) this.onViewPromo?.();
      else if (this.isActive) this.onManage?.(this.plan);
      else this.onSelect?.(this.plan, this.priceType === "annual");
    };
    $cta.setAttribute("type", "button");
  }

  private bindAction(element: HTMLElement, activate?: () => void): void {
    GESTURE_MANAGER.unregister(element);
    element.onclick = activate ?? null;
    element.onkeydown = activate ? event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
    } : null;
    if (activate) { element.setAttribute("role", "button"); element.tabIndex = 0; }
    else { element.removeAttribute("role"); element.removeAttribute("tabindex"); }
  }

  private showRedeemKeyPrompt(): void {
    const overlay = Overlay.instance.get();
    const $prompt = RedeemKeyPrompt.makeWith({
      onSubmit: (code) => {
        overlay.dismiss($prompt);
        this.onRedeemKey?.(code);
      },
      onCancel: () => {
        overlay.dismiss($prompt);
      },
    });
    overlay.reveal($prompt, {
      position: Overlay.Position.center(-100),
    });
  }

  private getCurrentPlanTier(): number {
    return this.activePlanTier;
  }

  static $styles = [
    Button.$style,
    css`
      #root {
        padding: 24px;
        color: var(--text-pri);
        height: 100%;
      }

      #spacer {
        display: var(--spacer-display, block);
      }

      #title-tag {
        position: relative;
        margin-left: 12px;
        --margin-bottom: 0.5px;
        color: var(--text-sec);
      }

      #title-tag:not(:empty)::before {
        position: absolute;
        content: "";
        inset: -2px -6px;
        border-radius: 4px;
        background: var(--blue);
        opacity: 0.5;
      }

      #title-section {
        margin-bottom: 4px;
        // height: var(--title-height, 420px);
        flex-grow: 1;
      }

      #caption {
        color: var(--text-ter);
      }

      hr {
        margin-block: 12px;
      }

      #features {
        padding-top: 32px;
        padding-bottom: 32px;
      }

      #features * {
        position: relative;
        --font-size: var(--plan-selector-feature-font-size, var(--p-size));
        --margin-bottom: 16px;
        color: var(--text-sec);
        padding-left: 20px;
      }

      #features *:last-child {
        --margin-bottom: 0px;
      }

      #features *::before {
        display: block;
        position: absolute;
        top: 0px;
        left: 0px;
        height: 16px;
        width: 16px;
        color: var(--text-sec);
        content: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24'%3E%3Cpath fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='m5 13l4 4L19 7'/%3E%3C/svg%3E");
      }

      #cta {
        height: 40px;
      }

      #cta:hover {
        --bg-btn: var(--blue);
        --fg-btn: white;
      }

      #annual-toggle {
        min-height: 40px;
      }

      #redeem-key-link {
        color: var(--text-sec);
        cursor: pointer;
        text-align: center;
        --margin-bottom: 8px;
        background: none;
        border: none;
        border-radius: 4px;
      }

      #view-promo-row {
        align-items: center;
        margin-bottom: 8px;
      }

      #promo-applied-label {
        color: var(--text-sec);
        cursor: pointer;
        --margin-bottom: 0px;
      }

      #promo-applied-label:hover {
        text-decoration: underline;
      }

      #change-promo-link {
        color: var(--text-sec);
        cursor: pointer;
        --margin-bottom: 0px;
      }

      #change-promo-link:hover {
        text-decoration: underline;
      }

      #redeem-key-link:hover:not(.prefilled) {
        text-decoration: underline;
      }

      #redeem-key-link.prefilled {
        display: block;
        background: var(--green-dimmed);
        color: var(--text-pri);
        cursor: default;
        pointer-events: none;
      }

      #redeem-key-link.prefilled::before {
        content: "\\2713 ";
        color: var(--green);
      }

      #cta:focus-visible,
      #redeem-key-link:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];

  static $html = html`
    <std-col id="root">
      <std-col id="title-section">
        <std-row style="align-items:flex-end;margin-bottom:12px;">
          <h2 id="title" class="h5"></h2>
          <p id="title-tag" class="small"></p>
        </std-row>
        <p id="caption" class="small"></p>
        <std-spacer id=spacer>
          <std-col id="features"></std-col>
        </std-spacer>
        <std-col id="pricing">
          <std-row style="justify-content:end;align-items:end;margin-bottom:12px;">
            <h1 id="price" class="h2"></h1>
            <p style="margin-inline:4px">/</p>
            <p id="price-period"></p>
          </std-row>
          <std-button-group-row id="annual-toggle"></std-button-group-row>
        </std-col>
      </std-col>
      <p id="redeem-key-link" type="button">Add promotion key</p>
      <std-row id="view-promo-row" style="display:none">
        <p id="promo-applied-label">← Promo Applied</p>
        <std-spacer></std-spacer>
        <p id="change-promo-link">Change</p>
      </std-row>
      <button id="cta"></button>
    </std-col>
  `;
}

@component({
  name: "std-redeem-key-prompt",
})
export class RedeemKeyPrompt extends LonaWebComponent {
  disconnectedCallback(): void {
    if (this.focusTimer != null) clearTimeout(this.focusTimer);
    this.focusTimer = null;
    super.disconnectedCallback();
  }

  private $bg: Round = this.hydrate<Round>("bg").bind({
    ...Round.Props.MODAL,
    bg: "var(--bg-elevated)",
  });
  private $input: EditableText = this.hydrate<EditableText>("input");
  private onSubmit?: (code: string) => void;
  private onCancel?: () => void;
  private focusTimer: Option<number> = null;

  static makeWith(props: RedeemKeyPrompt.Props): RedeemKeyPrompt {
    return RedeemKeyPrompt.make().bind(props);
  }

  bind(props: RedeemKeyPrompt.Props): this {
    this.onSubmit = props.onSubmit;
    this.onCancel = props.onCancel;

    PlanControls.promoInput.bind(this.$input, { placeholder: "Enter promotion key" });
    PlanControls.button.bind(this.$("cancel-btn") as HTMLButtonElement, { variant: "secondary", text: "Cancel" });
    PlanControls.button.bind(this.$("submit-btn") as HTMLButtonElement, { variant: "primary", text: "Redeem" });
    this.$input.controller.onEnterKey = (text) => {
      const code = text?.trim();
      if (!code) return;
      this.onSubmit?.(code);
    };

    this.$("submit-btn").onclick = () => {
      const code = this.$input.text?.trim();
      if (code) this.onSubmit?.(code);
    };
    this.$("cancel-btn").onclick = () => this.onCancel?.();

    // Focus input after a short delay to allow overlay animation
    if (this.focusTimer != null) clearTimeout(this.focusTimer);
    this.focusTimer = window.setTimeout(() => {
      this.focusTimer = null;
      if (this.isConnected) this.$input.enableEditing(true);
    }, 100);

    return this;
  }

  static $styles = [
    Button.$style,
    css`
      :host {
        width: 100%;
        max-width: 360px;
      }

      #root {
        border-radius: 8px;
        position: relative;
      }

      h1 {
        --margin-top: 8px;
        --margin-bottom: 4px;
        color: var(--text-sec);
      }

      p {
        --margin-top: 8px;
        --margin-bottom: 8px;
        color: var(--text-ter);
      }

      #content {
        padding: 16px;
      }

      #input {
        padding: 8px 12px;
        border: 1px solid var(--divider);
        border-radius: 4px;
        background: var(--bg);
        color: var(--text-pri);
        margin-top: 12px;
      }

      #submit-btn:focus-visible,
      #cancel-btn:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];

  static $html = html`
    <std-col id="root">
      <std-round id="bg" floating></std-round>
      <std-col id="content">
        <h1 class="h5">Add Promotion Key</h1>
        <p>Enter your promotion key to redeem</p>
        <std-editable-text id="input"></std-editable-text>
        <std-row style="margin-top:12px">
          <std-spacer></std-spacer>
          <button id="cancel-btn" secondary style="margin-right:8px">Cancel</button>
          <button id="submit-btn" primary>Redeem</button>
        </std-row>
      </std-col>
    </std-col>
  `;
}

export namespace RedeemKeyPrompt {
  export interface Props {
    onSubmit?: (code: string) => void;
    onCancel?: () => void;
  }
}

export namespace PlanSelector {
  export interface Plan {
    id: string;
    title: string;
    caption: string;
    tag?: Option<string>;
    tier: number;
    priceUsdPerMonth?: Option<number>;
    priceUsdPerMonthAnnual?: Option<number>;
    features: string[];
  }

  export interface Props {
    plans?: Plan[];
    activeProduct?: Option<string>;
    isPromoProduct?: boolean;
    isPaymentsTesting?: boolean;
    prefilledPromoCode?: Option<string>;
    onPlanSelect?: (plan: Plan, isYearly: boolean) => void;
    onCurrentPlanManage?: (plan: Plan) => void;
    onRedeemKey?: (code: string) => void;
    onContactUs?: () => void;
    onViewPromo?: () => void;
  }
}

export namespace PlanCard {
  export interface Props {
    plan: PlanSelector.Plan;
    isActive?: boolean;
    isPromoProduct?: boolean;
    activePlanTier?: number;
    isPaymentsTesting?: boolean;
    prefilledPromoCode?: Option<string>;
    onSelect?: (plan: PlanSelector.Plan, isYearly: boolean) => void;
    onManage?: (plan: PlanSelector.Plan) => void;
    onRedeemKey?: (code: string) => void;
    onContactUs?: () => void;
    onViewPromo?: () => void;
  }
}

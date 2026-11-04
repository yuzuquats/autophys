import { Column } from "@tento-ui/component-builtin";
import { Round } from "@tento-ui/components/round";
import { Storybook } from "@tento-ui/ui/storybook";
import type { NavDetailsConfig } from "./blog-design-system";
import { BrandNavDetails } from "./brand-nav-details";

export class BrandNavDetailsStoryBook extends Storybook.Default {
  override title(): string {
    return "brand-nav-details";
  }

  override examples(): Storybook.Example[] {
    return [
      {
        title: "With header and footer",
        render: () => this.renderInModal(this.makeFullConfig()),
      },
      {
        title: "Columns only",
        render: () => this.renderInModal(this.makeColumnsOnlyConfig()),
      },
    ];
  }

  private renderInModal(config: NavDetailsConfig) {
    const $container = Column.make();
    $container.assignStyles({ width: "100%", maxWidth: "840px" });
    const details = new BrandNavDetails();
    details.bind(this.makeContent(config));
    $container.appendChild(details.$el);

    const $modalContainer = Column.make();
    $modalContainer.assignStyles({ width: "100%", maxWidth: "840px" });
    $modalContainer.appendChild(
      Round.makeWithContent($container, Round.Props.MODAL),
    );
    return $modalContainer;
  }

  private makeContent(config: NavDetailsConfig): BrandNavDetails.Content {
    const [first, second, third] = config.columns;
    return {
      key: config.header ?? "default",
      header: config.header ?? null,
      columns: [first, second, third],
      footer: config.footer ?? null,
      image: config.image ?? null,
      selectedHref: null,
      onNavigate: () => {},
    };
  }

  private makeFullConfig(): NavDetailsConfig {
    const link = (label: string) => ({ label });

    return {
      header: "Explore teams, company size, and use cases",
      columns: [
        {
          title: "Teams",
          items: [
            link("Eng & Product"),
            link("Design"),
            link("Marketing"),
            link("IT"),
          ],
        },
        {
          title: "Company size",
          items: [
            link("Startups"),
            link("Small businesses"),
            link("Enterprise"),
          ],
        },
        {
          title: "Use Cases",
          items: [
            link("Education"),
            link("Personal"),
            link("Professional"),
            link("AI use cases"),
          ],
        },
      ],
      footer: {
        label: "View all",
      },
    };
  }

  private makeColumnsOnlyConfig(): NavDetailsConfig {
    const link = (label: string) => ({ label });

    return {
      header: null,
      columns: [
        {
          title: "Teams",
          items: [link("Platform"), link("Research"), link("Data")],
        },
        {
          title: "Company size",
          items: [link("Solo"), link("SMB"), link("Enterprise")],
        },
        {
          title: "Use Cases",
          items: [link("Publishing"), link("Operations"), link("Analytics")],
        },
      ],
      footer: null,
    };
  }
}

import { Storybook } from "../ui/storybook";
import { BrowserChrome } from "../components/browser-chrome";
import { MarketingFaq } from "./marketing-faq";

export class LonaMarketingFaqStoryBook extends Storybook.Default {
  title(): string {
    return "Marketing FAQ";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Marketing FAQ",
        render: () => {
          return BrowserChrome.makeExample(
            MarketingFaq.makeWith({
              title: "Frequently Asked Questions",
              items: [
                {
                  question: "What is Lona?",
                  answer:
                    "Lona is a powerful framework for building modern web applications.",
                },
                {
                  question: "How do I get started?",
                  answer:
                    "Getting started is easy! Clone the repository and follow the setup instructions.",
                },
              ],
            }),
            "ui.lona.so/faq",
          );
        },
      },
      {
        title: "Marketing FAQ",
        render: () =>
          MarketingFaq.makeWith({
            title: "Frequently Asked Questions",
            items: [
              {
                question: "What is Lona?",
                answer:
                  "Lona is a powerful framework for building modern web applications.",
              },
              {
                question: "How do I get started?",
                answer:
                  "Getting started is easy! Clone the repository and follow the setup instructions.",
              },
            ],
          }),
      },
    ];
  }
}

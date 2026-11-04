import { Storybook } from "../../ui/storybook";
import { LandingFaq } from "./landing-faq";

export class LandingFaqStoryBook extends Storybook.Default {
  title(): string {
    return "Landing FAQ";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Questions",
        render: () =>
          LandingFaq.makeWith({
            items: [
              {
                question: "How do formula rows work?",
                answer:
                  "A formula row computes its values using an expression that can reference other rows by name.",
              },
              {
                question: "Can teams use Lona without sharing health data?",
                answer:
                  "Yes. Teams can plan around shared availability while private rows remain private.",
              },
              {
                question: "What makes timezone handling different?",
                answer:
                  "Events display in the timezone they were created in, not only the device's current timezone.",
              },
            ],
          }),
      },
    ];
  }
}

import { Storybook } from "../../ui/storybook";
import { Documentation } from "./documentation";

const LISP_DOCS_WITH_EXAMPLES = `# Lisp Interactive Documentation

This demonstrates ProseMirror with embedded interactive Lisp examples.

## Basic Arithmetic

Try this simple addition:

<std-lisp-example code="(+ 1 2 3)"></std-lisp-example>


## Functions

Here's a factorial function you can run:

<std-lisp-example code="(define (factorial n)&#10;  (if (&lt;= n 1)&#10;      1&#10;      (* n (factorial (- n 1)))))&#10;&#10;(factorial 5)"></std-lisp-example>

## List Operations

Map over a list with a lambda:

<std-lisp-example code="(define lst '(1 2 3 4 5))&#10;&#10;(map (lambda (x) (* x x)) lst)"></std-lisp-example>

## Conclusion

These examples are fully interactive - edit the code and click Run to see the results!`;

export class DocumentationStoryBook extends Storybook.Default {
  title(): string {
    return "Documentation (with Lisp)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Interactive Lisp Documentation",
        render: () => {
          const $doc = Documentation.make();
          $doc.assignStyles({
            width: "100%",
            maxWidth: "600px",
            height: "600px",
            borderRadius: "8px",
            background: "var(--bg)",
            overflow: "auto",
            padding: "24px 12px",
          });
          $doc.bind({
            markdown: LISP_DOCS_WITH_EXAMPLES,
          });
          return $doc;
        },
      },
      {
        title: "Simple Example",
        render: () => {
          const $doc = Documentation.make();
          $doc.assignStyles({
            width: "100%",
            maxWidth: "400px",
            height: "300px",
            borderRadius: "8px",
            background: "var(--bg)",
            overflow: "auto",
          });
          $doc.bind({
            markdown: `# Quick Start

Try running this code:

<std-lisp-example code="(+ 10 20 30)"></std-lisp-example>`,
          });
          return $doc;
        },
      },
      {
        title: "Compact preset",
        render: () => {
          const $doc = Documentation.make();
          $doc.toggleAttribute("compact", true);
          $doc.assignStyles({
            width: "100%",
            maxWidth: "400px",
            borderRadius: "8px",
            background: "var(--bg)",
          });
          $doc.style.setProperty("--editor-max-width", "none");
          $doc.style.setProperty("--editor-padding", "0");
          $doc.bind({
            markdown:
              "### Heading\n\nA paragraph with `code` and a list:\n\n- one\n- two\n\n```\ncode block\n```",
          });
          return $doc;
        },
      },
    ];
  }
}

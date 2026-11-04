import { Storybook } from "../../ui/storybook";
import { LispExample } from "./lisp-example";

export class LispExampleStoryBook extends Storybook.Default {
  title(): string {
    return "Lisp Example";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Simple Arithmetic",
        render: () => {
          const $example = LispExample.make();
          $example.bind({
            code: "(+ 1 2 3)",
            editable: true,
          });
          return $example.assignStyles({
            width: "100%",
            maxWidth: "400px",
          });
        },
      },
      {
        title: "Factorial Function",
        render: () => {
          const $example = LispExample.make();
          $example.bind({
            code: `(define (factorial n)
  (if (<= n 1)
      1
      (* n (factorial (- n 1)))))

(factorial 5)`,
            editable: true,
          });
          return $example.assignStyles({
            width: "100%",
            maxWidth: "400px",
          });
        },
      },
      {
        title: "Fibonacci",
        render: () => {
          const $example = LispExample.make();
          $example.bind({
            code: `(define (fib n)
  (cond
    ((= n 0) 0)
    ((= n 1) 1)
    (else (+ (fib (- n 1))
             (fib (- n 2))))))

(fib 10)`,
            editable: true,
          });
          return $example.assignStyles({
            width: "100%",
            maxWidth: "400px",
          });
        },
      },
      {
        title: "List Operations",
        render: () => {
          const $example = LispExample.make();
          $example.bind({
            code: `(define lst '(1 2 3 4 5))

(map (lambda (x) (* x x)) lst)`,
            editable: true,
          });
          return $example.assignStyles({
            width: "100%",
            maxWidth: "400px",
          });
        },
      },
      {
        title: "Read-only Example",
        render: () => {
          const $example = LispExample.make();
          $example.bind({
            code: `; This example is read-only
(define (hello name)
  (+ "Hello, " name "!"))

(hello "World")`,
            editable: false,
          });
          return $example.assignStyles({
            width: "100%",
            maxWidth: "400px",
          });
        },
      },
      {
        title: "Lambda Functions",
        render: () => {
          const $example = LispExample.make();
          $example.bind({
            code: `; Anonymous function
((lambda (x y) (+ x y)) 10 20)

; Stored in variable
(define add (lambda (x y) (+ x y)))
(add 5 3)`,
            editable: true,
          });
          return $example.assignStyles({
            width: "100%",
            maxWidth: "400px",
          });
        },
      },
    ];
  }
}

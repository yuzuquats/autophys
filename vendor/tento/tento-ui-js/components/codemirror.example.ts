import { Storybook } from "../ui/storybook";
import { CodeMirrorEditor } from "./codemirror";

const LISP_EXAMPLE = `; Simple Lisp example
(defun factorial (n)
  (if (<= n 1)
      1
      (* n (factorial (- n 1)))))

(defun fibonacci (n)
  (cond ((= n 0) 0)
        ((= n 1) 1)
        (t (+ (fibonacci (- n 1))
              (fibonacci (- n 2))))))

; Bind variables with let*
(defun example ()
  (let* ((x 10)
         (y 20)
         (z (+ x y)))
    (* z 2)))

; Example with strings
(defun hello (name)
  (format nil "Hello, ~a!" name))
`;

export class CodeMirrorStoryBook extends Storybook.Default {
  tags(): string[] {
    return ["std-codemirror"];
  }

	title(): string {
		return "CodeMirror";
	}

	examples(): Storybook.Example[] {
		return [
			{
				title: "Lisp",
				render: () => {
					const $editor = CodeMirrorEditor.make();
					$editor.assignStyles({
						height: "300px",
						borderRadius: "8px",
						background: "var(--bg-surface-light)",
					});
					$editor.bind({
						content: LISP_EXAMPLE,
						language: "lisp",
						editable: true,
					});
					return $editor;
				},
			},
			{
				title: "Read-only",
				render: () => {
					const $editor = CodeMirrorEditor.make();
					$editor.assignStyles({
						height: "200px",
						borderRadius: "8px",
						background: "var(--bg-surface-light)",
					});
					$editor.bind({
						content: LISP_EXAMPLE,
						language: "lisp",
						editable: true,
					});
					return $editor;
				},
			},
		];
	}
}

import { Storybook } from "@tento-ui/ui/storybook";
import { html } from "../../component";
import { SimpleAuthPage } from "./simple-auth-page";
import { SimpleAuthCard } from "./simple-auth-card";
import { Button } from "../button/button";
import { BrowserChrome } from "../browser-chrome";

export class SimpleAuthCardStoryBook extends Storybook.Default {
  title(): string {
    return "Simple Auth Card";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Gmail Sign-in",
        render: () => {
          const $page = SimpleAuthPage.make();
          $page.style.height = "600px";

          const $card = SimpleAuthCard.make().bind({
            title: "Gmail Authorization",
            description: "Sign in with the Gmail account that will be used to send emails",
          });

          const $button = Button.makeWithLight("Sign in with Google", {
            type: "primary",
          });
          $button.slot = "action";
          $card.appendChild($button);

          const $status = document.createElement("span");
          $status.slot = "status";
          $status.textContent = "Ready to sign in";
          $card.appendChild($status);

          $page.appendChild($card);
          return BrowserChrome.makeExample($page, "admin.lona.so/signin", 800);
        },
      },
      {
        title: "Magic Link",
        render: () => {
          const $page = SimpleAuthPage.make();
          $page.style.height = "600px";

          const $card = SimpleAuthCard.make().bind({
            title: "Sign In",
            description: "Enter your email to receive a magic link",
          });

          const $input = document.createElement("input");
          $input.type = "email";
          $input.placeholder = "you@example.com";
          $input.slot = "action";
          $input.assignStyles({
            width: "100%",
            padding: "12px 16px",
            borderRadius: "8px",
            border: "1px solid var(--divider)",
            fontSize: "var(--text-16px)",
            boxSizing: "border-box",
          });
          $card.appendChild($input);

          const $button = Button.makeWithLight("Send Magic Link", {
            type: "primary",
          });
          $button.slot = "action";
          $button.style.marginTop = "12px";
          $card.appendChild($button);

          const $footer = html`
            <p slot="footer">
              By signing in, you agree to our
              <a href="#">Terms</a> and <a href="#">Privacy Policy</a>.
            </p>
          `.content.cloneNode(true);
          $card.appendChild($footer);

          $page.appendChild($card);
          return BrowserChrome.makeExample($page, "app.example.com/signin", 800);
        },
      },
      {
        title: "Two-Factor Authentication",
        render: () => {
          const $page = SimpleAuthPage.make();
          $page.style.height = "600px";

          const $card = SimpleAuthCard.make().bind({
            title: "Two-Factor Authentication",
            description: "Enter the 6-digit code from your authenticator app",
          });

          const $codeContainer = document.createElement("std-row");
          $codeContainer.slot = "action";
          $codeContainer.assignStyles({
            gap: "8px",
            justifyContent: "center",
          });

          for (let i = 0; i < 6; i++) {
            const $digit = document.createElement("input");
            $digit.type = "text";
            $digit.maxLength = 1;
            $digit.assignStyles({
              width: "48px",
              height: "56px",
              textAlign: "center",
              fontSize: "var(--h4-size)",
              fontWeight: "600",
              borderRadius: "8px",
              border: "1px solid var(--divider)",
            });
            $codeContainer.appendChild($digit);
          }
          $card.appendChild($codeContainer);

          const $button = Button.makeWithLight("Verify", {
            type: "primary",
          });
          $button.slot = "action";
          $button.style.marginTop = "12px";
          $card.appendChild($button);

          const $footer = document.createElement("p");
          $footer.slot = "footer";
          $footer.innerHTML = `<a href="#">Use backup code</a>`;
          $card.appendChild($footer);

          $page.appendChild($card);
          return BrowserChrome.makeExample($page, "app.example.com/2fa", 800);
        },
      },
      {
        title: "Multiple Providers",
        render: () => {
          const $page = SimpleAuthPage.make();
          $page.style.height = "700px";

          const $card = SimpleAuthCard.make().bind({
            title: "Welcome Back",
            description: "Sign in to continue",
          });

          const providers = [
            { name: "Google", icon: "G" },
            { name: "GitHub", icon: "GH" },
            { name: "Microsoft", icon: "M" },
          ];

          for (const provider of providers) {
            const $button = Button.makeWithLight(`Sign in with ${provider.name}`, {
              type: "secondary",
            });
            $button.slot = "action";
            $button.assignStyles({
              marginTop: "8px",
            });
            $card.appendChild($button);
          }

          const $divider = document.createElement("std-row");
          $divider.slot = "action";
          $divider.assignStyles({
            alignItems: "center",
            gap: "16px",
            marginTop: "16px",
          });
          $divider.innerHTML = `
            <hr style="flex:1;border:none;border-top:1px solid var(--divider);">
            <span style="color:var(--text-ter);font-size:var(--text-14px);">or</span>
            <hr style="flex:1;border:none;border-top:1px solid var(--divider);">
          `;
          $card.appendChild($divider);

          const $emailButton = Button.makeWithLight("Continue with Email", {
            type: "primary",
          });
          $emailButton.slot = "action";
          $emailButton.style.marginTop = "8px";
          $card.appendChild($emailButton);

          const $footer = html`
            <p slot="footer">
              Don't have an account? <a href="#">Sign up</a>
            </p>
          `.content.cloneNode(true);
          $card.appendChild($footer);

          $page.appendChild($card);
          return BrowserChrome.makeExample($page, "app.example.com/signin", 800);
        },
      },
    ];
  }
}

import { Storybook } from "@tento-ui/ui/storybook";
import { html } from "../../component";
import { AuthPage } from "./auth-page";
import { AuthPageStatus } from "./auth-page-status";
import { Button } from "../button/button";
import { BrowserChrome } from "../browser-chrome";

export class AuthPageStoryBook extends Storybook.Default {
  title(): string {
    return "Auth Page";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Auth Page",
        render: () => {
          const $c = AuthPage.make();
          $c.style.height = "840px";

          $c.appendChild(
            html`
						<std-col slot="title" style=align-self:start;>
							<std-row>
								<h1 id=title class=h2 style="--margin-bottom:12px">Lona</h1>
							</std-row>
							<h2 id=subtitle class=h6 style="color:var(--text-ter);font-weight:400;">Calendar, Tasks, Sheets. All in one.</h1>
							<p style=color:var(--text-sec);display:none;>Calendar. Notes. Tasks.</p>
						</std-col>
					`.content.cloneNode(true),
          );
          $c.appendChild(
            Button.makeWithLight("Get Started", {
              type: "primary",
            }).assignStyles({
              width: "100%",
              maxWidth: "600px",
            }),
          );
          $c.appendChild(
            html`<a slot="privacy-policy" href="#">Privacy Policy</a>`.content.cloneNode(
              true,
            ),
          );
          $c.appendChild(
            html`<a slot="tos" href="#">Terms of Service</a>`.content.cloneNode(
              true,
            ),
          );
          return BrowserChrome.makeExample($c, "ui.lona.so/signin", 1200);
        },
      },
      {
        title: "Single Error Status",
        render: () => {
          const $c = AuthPage.make();
          $c.style.height = "840px";

          $c.appendChild(
            html`
						<std-col slot="title" style=align-self:start;>
							<std-row>
								<h1 id=title class=h2 style="--margin-bottom:12px">Lona</h1>
							</std-row>
							<h2 id=subtitle class=h6 style="color:var(--text-ter);font-weight:400;">Calendar, Tasks, Sheets. All in one.</h1>
							<p style=color:var(--text-sec);display:none;>Calendar. Notes. Tasks.</p>
						</std-col>
					`.content.cloneNode(true),
          );

          const $status = AuthPageStatus.make().bind({
            variant: "error",
            message: "Missing required Google Calendar scopes",
            code: null,
          });
          $status.slot = "status";
          $c.appendChild($status);

          $c.appendChild(
            Button.makeWithLight("Get Started", {
              type: "primary",
            }).assignStyles({
              width: "100%",
              maxWidth: "600px",
            }),
          );
          $c.appendChild(
            html`<a slot="privacy-policy" href="#">Privacy Policy</a>`.content.cloneNode(
              true,
            ),
          );
          $c.appendChild(
            html`<a slot="tos" href="#">Terms of Service</a>`.content.cloneNode(
              true,
            ),
          );
          return BrowserChrome.makeExample($c, "ui.lona.so/signin", 1200);
        },
      },
      {
        title: "Single Promo Status",
        render: () => {
          const $c = AuthPage.make();
          $c.style.height = "840px";

          $c.appendChild(
            html`
						<std-col slot="title" style=align-self:start;>
							<std-row>
								<h1 id=title class=h2 style="--margin-bottom:12px">Lona</h1>
							</std-row>
							<h2 id=subtitle class=h6 style="color:var(--text-ter);font-weight:400;">Calendar, Tasks, Sheets. All in one.</h1>
							<p style=color:var(--text-sec);display:none;>Calendar. Notes. Tasks.</p>
						</std-col>
					`.content.cloneNode(true),
          );

          const $status = AuthPageStatus.make().bind({
            variant: "promo",
            message: "Google Calendar connected successfully",
            code: null,
          });
          $status.slot = "status";
          $c.appendChild($status);

          $c.appendChild(
            Button.makeWithLight("Get Started", {
              type: "primary",
            }).assignStyles({
              width: "100%",
              maxWidth: "600px",
            }),
          );
          $c.appendChild(
            html`<a slot="privacy-policy" href="#">Privacy Policy</a>`.content.cloneNode(
              true,
            ),
          );
          $c.appendChild(
            html`<a slot="tos" href="#">Terms of Service</a>`.content.cloneNode(
              true,
            ),
          );
          return BrowserChrome.makeExample($c, "ui.lona.so/signin", 1200);
        },
      },
      {
        title: "Multiple Statuses",
        render: () => {
          const $c = AuthPage.make();
          $c.style.height = "840px";

          $c.appendChild(
            html`
						<std-col slot="title" style=align-self:start;>
							<std-row>
								<h1 id=title class=h2 style="--margin-bottom:12px">Lona</h1>
							</std-row>
							<h2 id=subtitle class=h6 style="color:var(--text-ter);font-weight:400;">Calendar, Tasks, Sheets. All in one.</h1>
							<p style=color:var(--text-sec);display:none;>Calendar. Notes. Tasks.</p>
						</std-col>
					`.content.cloneNode(true),
          );

          const $status1 = AuthPageStatus.make().bind({
            variant: "promo",
            message: "Google Calendar connected",
            code: null,
          });
          $status1.slot = "status";
          $c.appendChild($status1);

          const $status2 = AuthPageStatus.make().bind({
            variant: "error",
            message: "Missing required scopes for Google Tasks",
            code: null,
          });
          $status2.slot = "status";
          $c.appendChild($status2);

          const $status3 = AuthPageStatus.make().bind({
            variant: "promo",
            message: "Google Drive connected",
            code: null,
          });
          $status3.slot = "status";
          $c.appendChild($status3);

          $c.appendChild(
            Button.makeWithLight("Get Started", {
              type: "primary",
            }).assignStyles({
              width: "100%",
              maxWidth: "600px",
            }),
          );
          $c.appendChild(
            html`<a slot="privacy-policy" href="#">Privacy Policy</a>`.content.cloneNode(
              true,
            ),
          );
          $c.appendChild(
            html`<a slot="tos" href="#">Terms of Service</a>`.content.cloneNode(
              true,
            ),
          );
          return BrowserChrome.makeExample($c, "ui.lona.so/signin", 1200);
        },
      },
    ];
  }
}

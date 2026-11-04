import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Row } from "../../component-builtin";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Checkbox } from "../controls/checkbox";
import { Form } from "./form";

const WINDOW_REFUSED =
  "control host answered 404 — rwc-01 may not serve dev.lona.so; check the " +
  "control host / domain pair";

/** The add-host modal's real shape, at its real width: the rows a form-level
 * refusal has to be read against. Built fresh per card because `setError` is
 * instance state, not a prop. */
function $hostForm(): Form {
  const $form = Form.builder()
    .textInput("id", "Host id", { placeholder: "rwc-04" })
    .textInput("sshUser", "SSH user", { placeholder: "james" })
    .selectInput("controlHost", "Control host", [
      { value: "yuzuquats", label: "yuzuquats" },
      { value: "rwc-01", label: "rwc-01" },
    ])
    .selectInput("controlDomain", "Control domain", [
      { value: "dev.lona.so", label: "dev.lona.so" },
      { value: "lona.so", label: "lona.so" },
    ])
    .submit("Continue")
    .cancel("Cancel")
    .build();
  $form.style.width = "420px";
  return $form;
}

export class FormStoryBook extends Storybook.Default {
  title(): string {
    return "Form Input Examples";
  }

  tags(): string[] {
    return ["std-form"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Action accessory — dry run beside the submit button",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description: "A leading control shares the action row with Run configuration at 380px.",
        render: () => {
          const $dryRun = Checkbox.makeWith({ checked: false, onChange: () => {} });
          const $label = Typography.small("Dry run");
          const $accessory = Row.make();
          $accessory.assignStyles({ alignItems: "center", gap: "8px" });
          $accessory.append($dryRun, $label);
          GESTURE_MANAGER.addPointerEvent($label, {
            onClick: () => $dryRun.setChecked(!$dryRun.checked),
          });
          const $form = Form.make();
          $form.bind({
            ...Form.builder()
              .passwordInput("sudoPassword", "Sudo password", { autocomplete: "off" })
              .submit("Run configuration")
              .buildProps(),
            actionAccessory: $accessory,
          });
          $form.assignStyles({ width: "380px", maxWidth: "100%" });
          return $form;
        },
      },
      {
        title: "All Input Types",
        render: () => {
          return Storybook.fill(Form.builder()
            .title("All Input Types Reference")
            // Text inputs
            .textInput("text", "Text Input", {
              placeholder: "Enter text...",
              helperText: "Standard text input",
            })
            .emailInput("email", "Email Input", {
              placeholder: "user@example.com",
            })
            .passwordInput("password", "Password Input", {
              placeholder: "Enter password",
            })
            .telInput("tel", "Phone Input", {
              placeholder: "+1 (555) 123-4567",
            })
            .input({
              name: "url",
              label: "URL Input",
              type: "url",
              placeholder: "https://example.com",
            })
            .input({
              name: "search",
              label: "Search Input",
              type: "search",
              placeholder: "Search...",
            })
            // Numeric inputs
            .numberInput("number", "Number Input", {
              min: 0,
              max: 100,
              step: 1,
              value: "50",
              helperText: "Range: 0-100",
            })
            .sliderInput("range", "Range Slider", {
              min: 0,
              max: 100,
              step: 5,
              value: "50",
              helperText: "Lona-js SliderInput",
            })
            // Styled Date/Time inputs (Lona-js components)
            .dateInput("date", "Date Input", {
              placeholder: "Select date",
              helperText: "Lona-js DateInput",
            })
            .timeInput("time", "Time Input", {
              placeholder: "Select time",
              helperText: "Lona-js TimeInput",
            })
            .datetimeInput("datetime", "DateTime Input", {
              placeholder: "Select date",
              helperText: "Lona-js DateTimeInput",
            })
            // Native Date/Time inputs (browser default)
            .nativeDateInput("nativeDate", "Native Date", {
              helperText: "Native <input type=\"date\">",
            })
            .nativeTimeInput("nativeTime", "Native Time", {
              helperText: "Native <input type=\"time\">",
            })
            .nativeDatetimeInput("nativeDatetime", "Native DateTime", {
              helperText: "Native <input type=\"datetime-local\">",
            })
            .input({
              name: "month",
              label: "Month Input",
              type: "month",
              helperText: "Native <input type=\"month\">",
            })
            .input({
              name: "week",
              label: "Week Input",
              type: "week",
              helperText: "Native <input type=\"week\">",
            })
            // Color input
            .colorInput("color", "Color Input", {
              value: "#3b82f6",
              helperText: "Lona-js ColorInput",
            })
            // Select dropdown
            .selectInput(
              "select",
              "Select Input",
              [
                { value: "opt1", label: "Option 1" },
                { value: "opt2", label: "Option 2" },
                { value: "opt3", label: "Option 3" },
              ],
              {
                placeholder: "Choose an option...",
              },
            )
            // Text area
            .textareaInput("textarea", "Textarea Input", {
              placeholder: "Enter longer text here...",
              rows: 3,
            })
            // Rich text editor
            .richTextInput("richtext", "Rich Text Editor", {
              placeholder: "Format your text with **bold**, *italic*, etc.",
            })
            // Checkbox inputs
            .checkboxInput("checkbox", "Standard Checkbox (native)")
            .checkboxInput("checkboxCustom", "Custom Checkbox (styled)", {
              useCustomCheckbox: true,
              helperText: "Uses the std-checkbox component",
            })
            .submit({
              label: "Submit All",
              onClick: (inputs) => {
                console.log("All inputs:", inputs);
              },
            })
            .onChange((values) => {
              console.log("Form values changed:", values);
            })
            .build(), "420px");
        },
      },
      {
        title: "Basic Contact Form",
        render: () => {
          return Storybook.fill(Form.builder()
            .title("Contact Information")
            .textInput("firstName", "First Name", {
              placeholder: "John",
              required: true,
            })
            .textInput("lastName", "Last Name", {
              placeholder: "Doe",
              required: true,
            })
            .emailInput("email", "Email Address", {
              placeholder: "john.doe@example.com",
              required: true,
              helperText: "We'll never share your email with anyone else.",
            })
            .telInput("phone", "Phone Number", {
              placeholder: "+1 (555) 123-4567",
            })
            .submit({
              label: "Save Contact",
              onClick: (inputs) => {
                console.log("Contact form submitted:", inputs);
              },
            })
            .build(), "420px");
        },
      },
      {
        title: "User Registration Form",
        render: () => {
          return Storybook.fill(Form.builder()
            .title("Create Account")
            .textInput("username", "Username", {
              placeholder: "Choose a username",
              required: true,
              pattern: "^[a-zA-Z0-9_]{3,20}$",
              helperText: "3-20 characters, alphanumeric and underscore only",
            })
            .emailInput("email", "Email", {
              placeholder: "your.email@example.com",
              required: true,
            })
            .passwordInput("password", "Password", {
              placeholder: "Enter a strong password",
              required: true,
              helperText: "Minimum 8 characters",
            })
            .passwordInput("confirmPassword", "Confirm Password", {
              placeholder: "Re-enter your password",
              required: true,
            })
            .dateInput("birthdate", "Date of Birth")
            .selectInput(
              "country",
              "Country",
              [
                { value: "us", label: "United States" },
                { value: "uk", label: "United Kingdom" },
                { value: "ca", label: "Canada" },
                { value: "au", label: "Australia" },
                { value: "other", label: "Other" },
              ],
              {
                placeholder: "Select your country",
                required: true,
              },
            )
            .checkboxInput("terms", "I agree to the Terms and Conditions", {
              required: true,
            })
            .checkboxInput("newsletter", "Send me newsletter updates")
            .submit("Create Account")
            .cancel("Cancel")
            .build(), "420px");
        },
      },
      {
        title: "Product Feedback Form",
        render: () => {
          return Storybook.fill(Form.builder()
            .title("Product Feedback")
            .textInput("name", "Your Name", {
              placeholder: "Optional",
            })
            .selectInput(
              "product",
              "Product",
              [
                { value: "app", label: "Mobile App" },
                { value: "web", label: "Website" },
                { value: "api", label: "API" },
                { value: "docs", label: "Documentation" },
              ],
              {
                placeholder: "Select a product",
                required: true,
              },
            )
            .selectInput(
              "rating",
              "Overall Rating",
              [
                { value: "5", label: "⭐⭐⭐⭐⭐ Excellent" },
                { value: "4", label: "⭐⭐⭐⭐ Good" },
                { value: "3", label: "⭐⭐⭐ Average" },
                { value: "2", label: "⭐⭐ Poor" },
                { value: "1", label: "⭐ Very Poor" },
              ],
              {
                required: true,
              },
            )
            .textareaInput("feedback", "Your Feedback", {
              placeholder: "Tell us what you think...",
              rows: 5,
              required: true,
              helperText: "Please be as detailed as possible",
            })
            .richTextInput("suggestions", "Suggestions for Improvement", {
              placeholder: "Any ideas for new features or improvements?",
            })
            .submit({
              label: "Submit Feedback",
              onClick: (inputs) => {
                console.log("Feedback submitted:", inputs);
              },
            })
            .build(), "420px");
        },
      },
      {
        title: "Event Registration",
        render: () => {
          return Storybook.fill(Form.builder()
            .title("Event Registration")
            .textInput("attendeeName", "Full Name", {
              required: true,
            })
            .emailInput("attendeeEmail", "Email", {
              required: true,
            })
            .dateInput("preferredDate", "Preferred Date", {
              required: true,
            })
            .input({
              name: "preferredTime",
              label: "Preferred Time",
              type: "time",
              required: true,
            })
            .numberInput("numberOfGuests", "Number of Guests", {
              min: 1,
              max: 10,
              step: 1,
              value: "1",
            })
            .selectInput("mealPreference", "Meal Preference", [
              { value: "standard", label: "Standard" },
              { value: "vegetarian", label: "Vegetarian" },
              { value: "vegan", label: "Vegan" },
              { value: "gluten-free", label: "Gluten Free" },
            ])
            .textareaInput("specialRequests", "Special Requests", {
              placeholder: "Any dietary restrictions or accessibility needs?",
              rows: 3,
            })
            .submit("Register")
            .build(), "420px");
        },
      },
      {
        title: "Settings Form with Various Inputs",
        render: () => {
          return Storybook.fill(Form.builder()
            .title("Application Settings")
            .colorInput("theme", "Theme Color", {
              value: "#3b82f6",
            })
            .sliderInput("fontSize", "Font Size", {
              min: 12,
              max: 24,
              step: 1,
              value: "16",
              helperText: "Adjust the base font size",
            })
            .selectInput(
              "language",
              "Language",
              [
                { value: "en", label: "English" },
                { value: "es", label: "Español" },
                { value: "fr", label: "Français" },
                { value: "de", label: "Deutsch" },
              ],
              {
                value: "en",
              },
            )
            .checkboxInput("notifications", "Enable notifications", {
              checked: true,
            })
            .checkboxInput("darkMode", "Dark mode", {
              checked: false,
            })
            .checkboxInput("autoSave", "Auto-save", {
              checked: true,
              helperText: "Automatically save your work every 5 minutes",
            })
            .numberInput("autoSaveInterval", "Auto-save interval (minutes)", {
              min: 1,
              max: 60,
              value: "5",
            })
            .submit("Save Settings")
            .onChange((values) => {
              console.log("Settings changed:", values);
            })
            .build(), "420px");
        },
      },
      {
        title: "Form with Custom Checkboxes",
        render: () => {
          return Storybook.fill(Form.builder()
            .title("Notification Preferences")
            .checkboxInput("emailNotifications", "Email Notifications", {
              checked: true,
              useCustomCheckbox: true,
              helperText: "Receive important updates via email",
            })
            .checkboxInput("pushNotifications", "Push Notifications", {
              checked: false,
              useCustomCheckbox: true,
              helperText: "Get instant alerts on your device",
            })
            .checkboxInput("smsNotifications", "SMS Notifications", {
              checked: false,
              useCustomCheckbox: true,
              helperText: "Receive text messages for urgent alerts",
            })
            .checkboxInput("marketingEmails", "Marketing Emails", {
              checked: false,
              useCustomCheckbox: true,
              helperText: "Stay updated with our latest offers and news",
            })
            .checkboxInput("weeklyDigest", "Weekly Digest", {
              checked: true,
              useCustomCheckbox: true,
              helperText: "Get a summary of your activity every week",
            })
            .submit({
              label: "Save Preferences",
              onClick: (inputs) => {
                console.log("Notification preferences:", inputs);
              },
            })
            .onChange((values) => {
              console.log("Preferences changed:", values);
            })
            .build(), "420px");
        },
      },
      {
        title: "Date/Time Inputs (Lona-js)",
        render: () => {
          return Storybook.fill(Form.builder()
            .title("Lona-js Date/Time Inputs")
            .dateInput("date", "Date", {
              placeholder: "Select date",
              helperText: "DateInput with calendar dropdown",
            })
            .timeInput("time", "Time", {
              placeholder: "Select time",
              helperText: "TimeInput with time picker dropdown",
            })
            .datetimeInput("datetime", "DateTime", {
              placeholder: "Select date and time",
              helperText: "DateTimeInput (combined date + time)",
            })
            .submit({
              label: "Log Values",
              onClick: (inputs) => {
                console.log("Form values:", inputs);
              },
            })
            .onChange((values) => {
              console.log("Values changed:", values);
            })
            .build(), "420px");
        },
      },
      {
        title: "Date/Time Inputs (Native)",
        render: () => {
          return Storybook.fill(Form.builder()
            .title("Native HTML Date/Time Inputs")
            .nativeDateInput("date", "Date", {
              helperText: "Native <input type=\"date\">",
            })
            .nativeTimeInput("time", "Time", {
              helperText: "Native <input type=\"time\">",
            })
            .nativeDatetimeInput("datetime", "DateTime", {
              helperText: "Native <input type=\"datetime-local\">",
            })
            .input({
              name: "month",
              label: "Month",
              type: "month",
              helperText: "Native <input type=\"month\">",
            })
            .input({
              name: "week",
              label: "Week",
              type: "week",
              helperText: "Native <input type=\"week\">",
            })
            .submit({
              label: "Log Values",
              onClick: (inputs) => {
                console.log("Native form values:", inputs);
              },
            })
            .onChange((values) => {
              console.log("Native values changed:", values);
            })
            .build(), "420px");
        },
      },
      {
        title: "Nothing to say",
        render: () => $hostForm(),
      },
      {
        title: "Bound twice in one frame",
        render: () => {
          const $form = $hostForm();
          $form.bind(
            Form.builder()
              .textInput("id", "Host id", { placeholder: "rwc-04" })
              .textInput("sshUser", "SSH user", { placeholder: "james" })
              .selectInput("controlHost", "Control host", [
                { value: "yuzuquats", label: "yuzuquats" },
                { value: "rwc-01", label: "rwc-01" },
              ])
              .selectInput("controlDomain", "Control domain", [
                { value: "dev.lona.so", label: "dev.lona.so" },
                { value: "lona.so", label: "lona.so" },
              ])
              .submit("Opening the window...")
              .cancel("Cancel")
              .buildProps(),
          );
          return $form;
        },
      },
      {
        title: "A rejection that blames no field",
        render: () => {
          const $form = $hostForm();
          $form.setError(WINDOW_REFUSED);
          return $form;
        },
      },
      {
        title: "A refusal of one line",
        render: () => {
          const $form = $hostForm();
          $form.setError("the window closed before that machine answered");
          return $form;
        },
      },
    ];
  }
}

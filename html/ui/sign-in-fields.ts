/** Shared native credential fields for the workspace card and lona-js dialog. */
export const signInFields = (demo = false): string => `
  <input type="hidden" name="next" value="/app">
  <label>Email<input name="email" type="email" autocomplete="username" required></label>
  <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in</button>
  ${demo ? '<button type="submit" class="ap-signin-demo" formaction="/api/auth/demo" formnovalidate>Continue as demo</button>' : ""}`;

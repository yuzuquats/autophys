/**
 * `serve --login`: the server renders the account control (`#ap-account`: an avatar with a
 * Sign out popover, or an icon-only Sign in button) at the end of the page. Move it into the
 * cookbook header's right-hand links, so it is part of the header on the landing page and in
 * the app. The in-place sign-in swaps the element; it stays where it is.
 */
export function mountAccount(): void {
  const account = document.getElementById("ap-account");
  const links = document.querySelector(".ck-header .ck-nav-links");
  if (account && links && account.parentElement !== links) links.append(account);
}

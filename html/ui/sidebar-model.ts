/** Derived connection and navigation state for the application rail. */
export type SidebarExtras = {
  connection?: { lastRecord: string; error: string };
  creatingProject?: boolean;
};

import { Uuid } from "@tento-core/uuid";

export namespace UserAgent {
  export enum UserAgentPlatform {
    Windows = 0,
    Mac = 1,
    Unknown = 2,
  }

  export function getPlatform(): UserAgentPlatform {
    if (navigator.userAgent.includes("Windows")) {
      return UserAgentPlatform.Windows;
    } else if (navigator.userAgent.includes("Macintosh")) {
      return UserAgentPlatform.Mac;
    }
    return UserAgentPlatform.Unknown;
  }
}

export class Session {
  static KEY = "session-id";

  // todo: it's possible that we have collisions here - the problem is that
  // we need a way to lock a key between different window instances?
  static get browserId(): number {
    const existing = sessionStorage.getItem(Session.KEY);
    if (existing) return Number.parseInt(existing);

    const id = Math.floor(Math.random() * 512);
    sessionStorage.setItem(Session.KEY, String(id));
    return id;
  }

  private static _windowId = Math.floor(Math.random() * 512);
  static get windowId(): number {
    return Session._windowId;
  }
}

export namespace Session {
  export const ephId = Uuid.make();
  export const platform = UserAgent.getPlatform();
  export const isWindows = platform === UserAgent.UserAgentPlatform.Windows;
  export const isMacOs = platform === UserAgent.UserAgentPlatform.Mac;
  export const isSafari: boolean =
    !!navigator.userAgent &&
    /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  // Gecko Firefox only. Matches desktop/Android Firefox; excludes `FxiOS`
  // (Firefox on iOS is WebKit and behaves like Safari, not Gecko).
  export const isFirefox: boolean =
    !!navigator.userAgent && /firefox/i.test(navigator.userAgent);

  switch (platform) {
    case UserAgent.UserAgentPlatform.Windows:
      document.documentElement.setAttribute("platform", "windows");
      break;
    case UserAgent.UserAgentPlatform.Mac:
      document.documentElement.setAttribute("platform", "mac");
      break;
    case UserAgent.UserAgentPlatform.Unknown:
      break;
  }
}

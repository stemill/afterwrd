// Shapes that several files share, for the type checks (`npm run check`; the code itself is plain JavaScript).

/** Automatic updates, as the Update page and Home show them (src/auto.js autoState). */
interface AutoState {
  on: boolean;
  later?: boolean;
  /** Why they can't run (Cloudflare no longer allows it, say). */
  problem?: string | null;
  since?: number;
  signed?: boolean;
  running?: boolean | object | null;
  /** The release it'll install next, and when (after: seconds), or that it's waiting to be signed, or failed here. */
  next?: { version?: string; after?: number; unsigned?: boolean; failed?: boolean; [more: string]: unknown } | null;
  /** The last one: its version and how it went ("done", "kept", "unhealthy"…). */
  last?: { version?: string; result?: string; at?: number; [more: string]: unknown } | null;
  /** A release that's waiting to install. */
  waiting?: { version?: string; needsHand?: boolean; [more: string]: unknown } | null;
  lastCheck?: unknown;
  refusedAt?: number | null;
  groups?: unknown;
}

/** Whether friends' sites may check this one by themselves (src/friendchecks.js). */
interface CheckGrant {
  on?: boolean;
  later?: boolean;
  problem?: string | null;
}

/** A link in the header's menus (src/views/nav.js): badge is a count, or true for a dot. */
interface MenuItem {
  key: string;
  label: string;
  href: string;
  badge?: number | boolean | null;
}

/** A release's details from its manifest, as far as the checks need them. */
interface ReleaseInfo {
  version?: string;
  securityFix?: string;
  [more: string]: unknown;
}

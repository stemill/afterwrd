// What the browser scripts (public/static) share, and what browsers have that the standard types don't list, for the
// type checks (tsconfig.browser.json).

interface Window {
  /** Asks in afterwrd's own box (ui/confirm.js): true for yes. */
  askFirst(message: string, words?: { ok?: string; cancel?: string }): Promise<boolean>;
  /** Words in a box (textarea[data-draft]) have reached the site: no need to keep them on this device (ui/drafts.js). */
  afterwrdSent(box: HTMLTextAreaElement | null | undefined): void;
  /** live.js's state, for the tests. */
  afterwrdLive?: unknown;
  /** Chrome's "Save as" (export/main.js); not in every browser. */
  showSaveFilePicker?(options?: object): Promise<any>;
}

interface Navigator {
  /** Safari: opened from the home screen. */
  standalone?: boolean;
}

/** zip.js, loaded by its own script tag (public/static/vendor) on the import and download pages. */
declare const zip: any;

// What every signed-in page does in the browser (nav.js loads this, as a module): each part is a file of its own, run in
// this order, the same on every page. Without scripts, every form still works the plain way.
//
//   confirm.js   asking first, in afterwrd's own box (window.askFirst too)
//   look.js      the Dark / Light / Auto switch
//   menus.js     the small V menus, and Edit opening the words
//   drafts.js    what you're writing, kept on this device until it's sent (window.afterwrdSent)
//   inplace.js   comments, edits, deletes, answers and notices sent without a new page
//   arriving.js  a page opened at something (#c12) showing it below the header
//   search.js    drop-downs you can type into
//   mentions.js  @ in a post or comment box: picking someone to mention
//   app.js       the home-screen app: the service worker, and Add to home screen
import "./confirm.js";
import "./look.js";
import "./menus.js";
import "./drafts.js";
import "./inplace.js";
import "./arriving.js";
import "./search.js";
import "./mentions.js";
import "./app.js";

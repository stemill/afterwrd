// Keeps an open page up to date, quietly. Every 30 seconds while the tab is in view, it asks the site what's changed
// since the page was made (src/live.js): the header's counts change in place, and if there are new posts or
// comments a small bar offers to show them. Nothing moves until you choose to, nothing pops up, nothing makes a
// sound, and nothing runs while the tab is hidden.
(() => {
  const header = document.querySelector("header.site[data-now]");
  if (!header) return;
  const since = header.dataset.now;
  const EVERY = 30_000;
  let last = Date.now();
  let stopped = false;

  const unique = (list) => [...new Set(list)].join(",");
  // The posts and photos this page shows comment boxes for: here, and on friends' sites.
  const targets = () => unique([...document.querySelectorAll('form[action="/_comments"] input[name=target]')].map((i) => i.value));
  const remote = () => unique([...document.querySelectorAll('form[action="/_feed/comments"]')]
    .map((f) => `${f.elements.connection?.value}:${f.elements.target?.value}`));
  // …and in groups.
  const groups = () => unique([...document.querySelectorAll("form[data-group][data-post]")].map((f) => `${f.dataset.group}:${f.dataset.post}`));

  function setCount(link, n) {
    if (!link) return;
    let count = link.querySelector(".count");
    if (!n) { count?.remove(); return; }
    if (!count) {
      count = document.createElement("span");
      count.className = "count";
      link.append(count);
    }
    count.innerHTML = "";
    count.append(String(n));
    const hidden = document.createElement("span");
    hidden.className = "hidden";
    hidden.textContent = " new";
    count.append(hidden);
  }

  let bar = null;
  function say(text) {
    if (!text) { bar?.remove(); bar = null; return; }
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "live-bar";
      bar.setAttribute("role", "status");
      const words = document.createElement("span");
      const show = document.createElement("button");
      show.textContent = "Show";
      show.addEventListener("click", () => location.reload());
      bar.append(words, show);
      document.body.append(bar);
    }
    bar.querySelector("span").textContent = text;
  }
  // A newer afterwrd: the dot on the picture, and "Update available" behind it.
  function markUpdate(version) {
    const link = header.querySelector('.menu a[href="/_admin/update"]');
    if (!version || !link || link.querySelector(".dot")) return;
    link.querySelector("span").textContent = "Update available";
    const dot = () => Object.assign(document.createElement("span"), { className: "dot" });
    link.append(dot());
    const summary = header.querySelector("details.me summary");
    if (summary && !summary.querySelector(".dot")) summary.append(dot());
  }

  const plural = (n, word) => `${n} new ${word}${n === 1 ? "" : "s"}`;

  async function check() {
    if (stopped || document.hidden) return;
    last = Date.now();
    const query = new URLSearchParams({ since, targets: targets(), remote: remote(), groups: groups() });
    let news;
    try {
      const res = await fetch(`/_live?${query}`, { cache: "no-store" });
      if (res.status === 401 || res.status === 404) { stopped = true; return; }
      if (!res.ok) return;
      news = await res.json();
    } catch { return; }
    setCount(header.querySelector('a[href="/activity"]'), news.notifications);
    setCount(header.querySelector('a[href="/friend"]'), news.requests);
    markUpdate(news.update);
    const parts = [];
    if (location.pathname === "/" && news.posts) parts.push(plural(news.posts, "post") + " from friends");
    if (news.comments) parts.push(plural(news.comments, "comment"));
    if (location.pathname === "/activity" && news.notifications) parts.push("New notifications");
    say(parts.join(" · "));
  }

  setInterval(check, EVERY);
  if (header.hasAttribute("data-ask-soon")) setTimeout(check, 1500);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - last > EVERY) check(); });
  window.afterwrdLive = { check }; // for the tests
})();

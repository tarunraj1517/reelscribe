/* ReelScribe shared site script.
   Put this file at: public/assets/js/site.js
   Every page already loads it, but it was missing (404). */

let isLoggedIn = false;
let userEmail = "";

/* Check login state once, update the nav link */
const identityReady = (async function resolveIdentity() {
  try {
    const me = await fetch("/me", { credentials: "same-origin" }).then(r => r.json());
    isLoggedIn = !!me.loggedIn;
    userEmail = me.email || "";
  } catch (e) {
    isLoggedIn = false;
  }

  const nav = document.getElementById("navAuth");
  if (nav && isLoggedIn) {
    nav.textContent = "Dashboard";
    nav.href = "/clips-dashboard.html";
  }
})();

/* Home page "Generate" button */
async function generateClips() {
  const input = document.getElementById("clipUrl");
  const wall = document.getElementById("clipLoginWall");
  const url = (input ? input.value : "").trim();

  if (!url) {
    alert("Please paste a YouTube URL!");
    return;
  }

  const ytRegex = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]{6,}/i;
  if (!ytRegex.test(url)) {
    alert("Please paste a valid YouTube link.");
    return;
  }

  await identityReady; // make sure /me has answered before deciding

  if (!isLoggedIn) {
    if (wall) {
      wall.style.display = "block";
      wall.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return;
  }

  window.location.href =
    "/clips-dashboard.html?ytUrl=" + encodeURIComponent(url) + "&autostart=1";
}

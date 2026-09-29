// Sets `data-theme` on <html> before the first paint, so the page
// background (index.css) matches the stored theme without a flash. The
// CSP forbids inline scripts, so this is a same-origin, render-blocking
// classic script in <head>. The React app then applies the StyleX theme
// (src/theme/preference.ts, whose storage key and rule this repeats).
(() => {
  let preference = null;
  try {
    preference = localStorage.getItem("kanshi-theme");
  } catch {
    // Storage blocked: follow the system.
  }
  const dark =
    preference === "dark" ||
    (preference !== "light" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();

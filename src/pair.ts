const current = new URL(window.location.href);
const basePath = current.pathname.replace(/\/pair(?:\/index\.html)?\/?$/u, '/');
const target = new URL(`${basePath}dashboard.html`, current.origin);
target.hash = window.location.hash;
window.location.replace(target);

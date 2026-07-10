// Draws the browser-tab favicon on a canvas so it can carry a live count
// badge — the number of sessions currently wanting attention.

let lastCount = -1;

export function updateFavicon(count: number): void {
  if (count === lastCount) return; // avoid redundant redraws every tick
  lastCount = count;

  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Dark rounded background + a ">_" prompt glyph (the app's identity).
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#e5e5e5";
  ctx.font = "bold 30px monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(">_", 8, size / 2 + 2);

  // Red badge with the count in the top-right corner.
  if (count > 0) {
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(size - 17, 17, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 24px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(count > 9 ? "9+" : String(count), size - 17, 18);
  }

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = canvas.toDataURL("image/png");
}

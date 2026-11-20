// The gd-* style layer extracted from components/ui/glassy-dashboard.tsx (frost, panel borders, metrics, badges,
// dock, dialog). Colours are remapped to Zecca's tokens (app/globals.css); light/dark follow the page theme.
export const glassStyles = `
.gd-app {
  --gd-ink: var(--ink);
  --gd-muted: var(--muted);
  --gd-line: color-mix(in srgb, var(--ink) 11%, transparent);
  --gd-rim: rgb(255 255 255 / 62%);
  --gd-edge-light: rgb(255 255 255 / 88%);
  --gd-edge-shade: rgb(70 52 20 / 13%);
  --gd-gloss: rgb(255 255 255 / 48%);
  --gd-frame: rgb(255 253 248 / 34%);
  --gd-rail: rgb(250 247 240 / 66%);
  --gd-card: rgb(255 253 249 / 60%);
  --gd-card-light: rgb(255 255 255 / 42%);
  --gd-raised: rgb(255 255 255 / 86%);
  --gd-inner: rgb(255 255 255 / 46%);
  --gd-surface: var(--surface);
  --gd-track: color-mix(in srgb, var(--ink) 9%, transparent);
  --gd-primary: var(--ink);
  --gd-primary-ink: var(--paper);
  --gd-pick: var(--surface);
  --gd-pick-ink: var(--ink);
  --gd-coral: var(--alert);
  --gd-teal: var(--in);
  --gd-ochre: var(--brass);
  --gd-graph-ink: var(--ink);
  --gd-focus: var(--brass);
  --gd-dark-shadow: 60 44 14;
  position: relative;
  isolation: isolate;
  min-block-size: 100svh;
  color: var(--gd-ink);
  font-family: var(--font-sans);
  font-variant-numeric: tabular-nums;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) .gd-app {
    --gd-rim: rgb(255 244 222 / 13%);
    --gd-edge-light: rgb(255 244 222 / 20%);
    --gd-edge-shade: rgb(0 0 0 / 40%);
    --gd-gloss: rgb(255 240 214 / 6%);
    --gd-frame: rgb(22 24 27 / 46%);
    --gd-rail: rgb(22 24 27 / 72%);
    --gd-card: rgb(24 26 30 / 64%);
    --gd-card-light: rgb(70 70 72 / 18%);
    --gd-raised: rgb(46 48 52 / 88%);
    --gd-inner: rgb(42 44 48 / 52%);
    --gd-dark-shadow: 0 0 0;
  }
}
:root[data-theme='dark'] .gd-app {
  --gd-rim: rgb(255 244 222 / 13%);
  --gd-edge-light: rgb(255 244 222 / 20%);
  --gd-edge-shade: rgb(0 0 0 / 40%);
  --gd-gloss: rgb(255 240 214 / 6%);
  --gd-frame: rgb(22 24 27 / 46%);
  --gd-rail: rgb(22 24 27 / 72%);
  --gd-card: rgb(24 26 30 / 64%);
  --gd-card-light: rgb(70 70 72 / 18%);
  --gd-raised: rgb(46 48 52 / 88%);
  --gd-inner: rgb(42 44 48 / 52%);
  --gd-dark-shadow: 0 0 0;
}
.gd-app *, .gd-app *::before, .gd-app *::after { box-sizing: border-box; }
.gd-sr { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

.gd-stage, .gd-top, .gd-dock {
  border: 1px solid var(--gd-rim);
  background: linear-gradient(148deg, var(--gd-gloss), transparent 19% 77%, color-mix(in srgb, var(--gd-gloss) 48%, transparent)), var(--gd-frame);
  box-shadow: inset 1px 1px 1px var(--gd-edge-light), inset -1px -1px 1px var(--gd-edge-shade),
    inset 0 0 7px var(--gd-gloss), 0 1px 3px rgb(var(--gd-dark-shadow) / 14%), 0 22px 72px rgb(var(--gd-dark-shadow) / 16%);
  backdrop-filter: blur(var(--gd-panel-frost, 12px)) saturate(1.2);
  -webkit-backdrop-filter: blur(var(--gd-panel-frost, 12px)) saturate(1.2);
}
.gd-top, .gd-dock { background: linear-gradient(165deg, var(--gd-gloss), transparent 32% 73%, var(--gd-gloss)), var(--gd-rail); backdrop-filter: blur(15px) saturate(1.3); -webkit-backdrop-filter: blur(15px) saturate(1.3); }
.gd-stage { border-radius: 34px; }

.gd-panel, .gd-metric, .gd-summary {
  min-inline-size: 0;
  border: 1px solid var(--gd-rim);
  border-radius: 20px;
  background: linear-gradient(144deg, var(--gd-card-light), transparent 66%), var(--gd-card);
  box-shadow: inset 0 1px 1px var(--gd-edge-light), inset 0 -1px 1px var(--gd-edge-shade), 0 6px 18px rgb(var(--gd-dark-shadow) / 8%);
  backdrop-filter: blur(var(--gd-panel-frost, 12px)) saturate(1.15);
  -webkit-backdrop-filter: blur(var(--gd-panel-frost, 12px)) saturate(1.15);
}
.gd-summary { background: var(--gd-inner); padding: 6px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.gd-summary .gd-metric { border-radius: 15px; }
.gd-panel { padding: 16px; }
.gd-panel-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 7px 12px; margin-block-end: 12px; }
.gd-panel-head h2 { font-size: 15px; font-weight: 760; letter-spacing: -.02em; margin: 0; }
.gd-panel-head p { font-size: 12px; color: var(--gd-muted); margin: 3px 0 0; }

.gd-metric { display: flex; flex-direction: column; justify-content: space-between; min-block-size: 104px; padding: 12px 13px; }
.gd-metric[data-tone="in"] {
  color: #fff;
  --gd-muted: rgb(236 248 243 / 86%);
  border-color: rgb(196 248 231 / 45%);
  background: radial-gradient(ellipse at 5% -20%, #3a9381, transparent 68%), linear-gradient(145deg, #1e7461, #0d4a3d);
  box-shadow: inset 0 1px 2px rgb(214 252 240 / 40%), 0 6px 14px rgb(19 78 64 / 16%);
}
.gd-metric-head { display: flex; justify-content: space-between; align-items: center; gap: 4px; min-inline-size: 0; font-size: 12px; font-weight: 700; color: var(--gd-muted); }
.gd-metric[data-tone="in"] .gd-metric-head { color: inherit; }
.gd-metric-icon { display: grid; place-items: center; flex: none; inline-size: 28px; block-size: 28px; border-radius: 10px; background: var(--gd-inner); box-shadow: inset 0 1px 0 var(--gd-gloss); color: var(--gd-ink); }
.gd-metric[data-tone="in"] .gd-metric-icon { background: rgb(235 255 247 / 16%); color: inherit; }
.gd-metric-icon svg { width: 14px; height: 14px; }
.gd-metric-value { display: block; font-size: clamp(22px, 2.3vw, 32px); line-height: 1.05; margin-block: 6px 6px; letter-spacing: -.04em; font-weight: 780; }
.gd-metric-caption { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; color: var(--gd-muted); font-size: 11px; font-weight: 600; }
.gd-delta { display: inline-flex; align-items: center; gap: 2px; color: var(--gd-teal); font-weight: 800; border-radius: 6px; padding: 2px 5px; background: color-mix(in srgb, var(--gd-teal) 12%, transparent); }
.gd-delta[data-attention="true"] { color: var(--gd-coral); background: color-mix(in srgb, var(--gd-coral) 11%, transparent); }
.gd-delta svg { width: 11px; height: 11px; stroke-width: 2.4; }

.gd-status {
  --gd-status-color: var(--gd-graph-ink);
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 8px; border-radius: 999px; font-size: 11px; font-weight: 740;
  background: color-mix(in srgb, var(--gd-status-color) 11%, var(--gd-inner));
  color: var(--gd-status-color); white-space: nowrap;
}
.gd-status[data-state="in"] { --gd-status-color: var(--gd-teal); }
.gd-status[data-state="alert"] { --gd-status-color: var(--gd-coral); }
.gd-status[data-state="sealed"] { --gd-status-color: var(--sealed); }
.gd-status[data-state="brass"] { --gd-status-color: var(--ink); background: color-mix(in srgb, var(--brass) 22%, var(--gd-inner)); }
.gd-status i { inline-size: 5px; block-size: 5px; border-radius: 50%; background: currentColor; }

.gd-primary, .gd-secondary {
  display: inline-flex; justify-content: center; align-items: center; gap: 7px;
  min-block-size: 44px; padding: 8px 16px;
  font-size: 14px; font-weight: 720; line-height: 1.2; border-radius: 14px;
  border: 1px solid transparent;
}
.gd-primary { background: var(--gd-primary); color: var(--gd-primary-ink); }
.gd-secondary { background: var(--gd-raised); border-color: var(--gd-rim); color: var(--gd-ink); }
.gd-primary:hover { filter: brightness(1.15); }
.gd-secondary:hover { background: var(--gd-surface); }
.gd-icon-button {
  position: relative; min-inline-size: 44px; min-block-size: 44px; display: inline-grid; place-items: center;
  border-radius: 999px; border: 1px solid var(--gd-line); padding: 0; background: var(--gd-inner); color: var(--gd-ink);
}
.gd-icon-button:hover { background: var(--gd-raised); }
.gd-icon-button svg { width: 18px; height: 18px; stroke-width: 1.75; }
.gd-period { display: inline-flex; align-items: center; padding: 3px; border-radius: 999px; border: 1px solid var(--gd-rim); background: var(--gd-inner); box-shadow: inset 0 1px 0 var(--gd-gloss); }
.gd-period button { min-block-size: 38px; min-inline-size: 56px; border: 0; border-radius: 999px; background: transparent; padding: 0 12px; font-size: 12px; font-weight: 720; white-space: nowrap; color: var(--gd-ink); }
.gd-period button[aria-pressed="true"] { background: var(--gd-primary); color: var(--gd-primary-ink); }

.gd-dock { display: flex; align-items: center; gap: 3px; padding: 4px; border-radius: 999px; z-index: 30; }
.gd-dock a {
  z-index: 1; position: relative; display: flex; gap: 6px; justify-content: center; align-items: center;
  min-inline-size: 44px; min-block-size: 44px; padding: 0 14px; border-radius: 999px;
  font-size: 12px; font-weight: 720; white-space: nowrap; color: var(--gd-ink); text-decoration: none;
}
.gd-dock a svg { width: 18px; height: 18px; stroke-width: 1.8; }
.gd-dock a[aria-current="page"] { color: var(--gd-pick-ink); }
.gd-dock a:not([aria-current="page"]):hover { background: var(--gd-inner); }
.gd-dock-indicator {
  position: absolute; inset: 0 auto auto 0; pointer-events: none; visibility: hidden;
  border-radius: 999px; background: var(--gd-pick);
  box-shadow: inset 0 1px 0 var(--gd-gloss), inset 0 -2px 0 var(--brass), 0 2px 7px rgb(var(--gd-dark-shadow) / 14%);
}
.gd-dock-indicator[data-ready="true"] { visibility: visible; transition: transform .3s cubic-bezier(.24, .89, .26, 1), width .3s cubic-bezier(.24, .89, .26, 1), height .3s cubic-bezier(.24, .89, .26, 1); }
.gd-dock-side { flex-direction: column; }
.gd-dock-side a { padding: 0; }
.gd-dock-side .gd-dock-text { display: none; }
.gd-dock-tip {
  display: none; position: absolute; left: calc(100% + 8px); z-index: 1; pointer-events: none;
  color: var(--gd-ink); background: var(--gd-surface); padding: 6px 9px; border: 1px solid var(--gd-rim);
  border-radius: 8px; box-shadow: 0 3px 8px rgb(var(--gd-dark-shadow) / 15%); font-size: 12px;
}
.gd-dock-side a:is(:hover, :focus-visible) .gd-dock-tip { display: inline; }
.gd-dock-bottom { position: fixed; inset: auto 12px calc(10px + env(safe-area-inset-bottom)); justify-content: space-between; }
.gd-dock-bottom a { flex: 1; flex-direction: column; gap: 3px; padding: 4px 6px; min-block-size: 52px; line-height: 1.2; font-size: 11px; }

.gd-dialog {
  max-inline-size: min(calc(100% - 26px), 460px); inline-size: 100%;
  border-radius: 24px; border: 1px solid var(--gd-rim); color: var(--gd-ink); padding: 0;
  background: var(--gd-surface); box-shadow: 0 20px 80px rgb(var(--gd-dark-shadow) / 34%);
}
.gd-dialog::backdrop { background: var(--scrim); backdrop-filter: blur(5px); }
.gd-dialog-inner { padding: 20px; }
.gd-dialog-inner > header { display: flex; gap: 10px; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.gd-dialog-inner h2 { font-size: 22px; font-weight: 780; letter-spacing: -.035em; margin: 0; }

@media (prefers-reduced-motion: reduce) {
  .gd-app *, .gd-app *::before, .gd-app *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active) {
  .gd-top, .gd-stage, .gd-dock, .gd-panel, .gd-metric, .gd-summary { background: var(--gd-surface); backdrop-filter: none; -webkit-backdrop-filter: none; }
  .gd-metric[data-tone="in"] { background: var(--gd-surface); color: var(--gd-ink); --gd-muted: var(--gd-ink); }
}
@media (forced-colors: active) {
  .gd-app { --gd-ink: CanvasText; --gd-muted: CanvasText; --gd-focus: Highlight; --gd-coral: LinkText; --gd-teal: Highlight; --gd-graph-ink: CanvasText; --gd-surface: Canvas; }
  .gd-app :is(.gd-metric, .gd-panel, .gd-dock, button, .gd-stage) { border: 1px solid CanvasText; }
  .gd-dock a[aria-current="page"] { border: 2px solid Highlight; }
}
`

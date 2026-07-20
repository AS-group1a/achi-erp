// drawing.js — standalone AutoCAD-style drawing dialog. No deps, no network.
//   achi_drawing.open({ title, initial, onSave, onClose })
//     initial : JSON string — {version,shapes,scale} envelope, or a bare shapes
//               array (legacy, scale defaults). "" / null / garbage -> blank canvas.
//     onSave  : (json, hasShapes) -> void | Promise. json is the full envelope, so
//               dimension calibration survives the round-trip. Reject keeps the
//               dialog open.
//     onClose : called exactly once, whatever closes the dialog.

"use strict";

window.achi_drawing = (() => {

  let _isOpen = false;   // one dialog at a time
  let _styled = false;

  const GRID = 20;       // px between snap points
  const DRAW_UNITS = { "m": 1, "cm": 100, "mm": 1000, "ft": 3.28084, "in": 39.3701 };

  const SVG_RULER = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/></svg>`;

  // Accepts a bare shapes array, or the legacy {version,shapes,scale} envelope.
  function parse(raw) {
    if (!raw || typeof raw !== "string") return { shapes: [], scale: null };
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return { shapes: p.filter(s => s && typeof s === "object"), scale: null };
      if (p && Array.isArray(p.shapes)) {
        return { shapes: p.shapes.filter(s => s && typeof s === "object"), scale: p.scale || null };
      }
    } catch { /* fall through to blank */ }
    return { shapes: [], scale: null };
  }

  function open(opts) {
    if (_isOpen) return;
    _isOpen = true;
    _inject_styles();
    _show(opts || {});
  }

  function _show(opts) {
    const { title = "Drawing", initial = "", onSave = null, onClose = null } = opts;

    const saved = parse(initial);
    let shapes = saved.shapes;
    const scale = saved.scale && saved.scale.pxPerMeter > 0
      ? { pxPerMeter: saved.scale.pxPerMeter, unit: DRAW_UNITS[saved.scale.unit] ? saved.scale.unit : "m" }
      : { pxPerMeter: GRID, unit: "m" };

    let displayPxPerMeter = scale.pxPerMeter;
    let scaleAnimFrame = null;
    let history = [];
    let redoStack = [];

    const saveState = () => {
      const json = JSON.stringify(shapes);
      if (!history.length || history[history.length - 1] !== json) history.push(json);
      redoStack = [];
    };

    let tool = "line";
    let color = "#1f272e";
    let selectedShapeIndices = [];
    let transformState = null;
    let draftShape = null;
    let arcDraft = null;
    let boxSelectDraft = null;
    let textInputEl = null;
    let propsPanelEl = null;
    let chainStart = null;
    let anchorJustPlaced = false;
    let pointerDown = false;
    let downPos = null;
    let pointerMoved = false;
    let freeDrawing = false;
    let freePoints = [];
    let eraseMode = false;
    let eraseModeSaved = false;
    let dimDraft = null;
    let dimDragIdx = null;
    let dimHitWasLabel = false;
    let _valInputEl = null;
    let _valShapeIdx = null;

    // ── modal shell ─────────────────────────────────────────────────────────
    const unitOpts = Object.keys(DRAW_UNITS).map(u =>
      `<option value="${u}"${u === scale.unit ? " selected" : ""}>${u}</option>`
    ).join("");

    const overlay = document.createElement("div");
    overlay.className = "acd-overlay";
    overlay.innerHTML = `
      <div class="acd-box" role="dialog" aria-modal="true">
        <div class="acd-head">
          <div class="acd-title"></div>
          <button class="acd-x" type="button" title="Close" aria-label="Close">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>
          </button>
        </div>
        <div class="acd-body">
          <div class="fd-draw-dialog">
            <div class="fd-draw-toolbar">
              <div class="fd-draw-tools">
                <button class="fd-draw-tool" data-tool="select" title="Select / move / scale">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>
                </button>
                <button class="fd-draw-tool fd-draw-tool--active" data-tool="line" title="Draw lines">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="4" y1="20" x2="20" y2="4"/><circle cx="4" cy="20" r="2" fill="currentColor"/><circle cx="20" cy="4" r="2" fill="currentColor"/></svg>
                </button>
                <button class="fd-draw-tool" data-tool="rect" title="Draw rectangle">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
                </button>
                <button class="fd-draw-tool" data-tool="circle" title="Draw circle">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>
                </button>
                <button class="fd-draw-tool" data-tool="text" title="Add text">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
                </button>
                <button class="fd-draw-tool" data-tool="freehand" title="Freehand draw">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17 Q7 10 10 14 Q13 18 16 10 Q19 2 21 8"/></svg>
                </button>
                <button class="fd-draw-tool" data-tool="eraser" title="Eraser">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20H7L3 16l11-11 6 6-4.5 4.5"/><path d="M6.5 17.5l4-4"/></svg>
                </button>
                <button class="fd-draw-tool" data-tool="measure" title="Dimension">${SVG_RULER}</button>
                <div class="fd-draw-sep"></div>
                <button class="fd-draw-tool fd-draw-color-btn fd-draw-color-active" data-color="#1f272e" title="Black"><span class="fd-draw-swatch" style="background:#1f272e"></span></button>
                <button class="fd-draw-tool fd-draw-color-btn" data-color="#e74c3c" title="Red"><span class="fd-draw-swatch" style="background:#e74c3c"></span></button>
                <button class="fd-draw-tool fd-draw-color-btn" data-color="#2563eb" title="Blue"><span class="fd-draw-swatch" style="background:#2563eb"></span></button>
                <button class="fd-draw-tool fd-draw-color-btn" data-color="#16a34a" title="Green"><span class="fd-draw-swatch" style="background:#16a34a"></span></button>
                <button class="fd-draw-tool fd-draw-color-btn" data-color="#d97706" title="Amber"><span class="fd-draw-swatch" style="background:#d97706"></span></button>
                <div class="fd-draw-sep"></div>
                <span class="fd-draw-unit-label">Units</span>
                <select class="fd-draw-unit" title="Display unit">${unitOpts}</select>
                <div class="fd-draw-sep"></div>
                <button class="fd-draw-undo-btn" type="button" title="Undo (Ctrl+Z)">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
                  Undo
                </button>
                <button class="fd-draw-redo-btn" type="button" title="Redo (Ctrl+Shift+Z)">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
                  Redo
                </button>
              </div>
              <button class="fd-draw-clear-btn" type="button">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                Clear
              </button>
            </div>
            <div class="fd-draw-canvas-wrap"><canvas class="fd-draw-canvas"></canvas></div>
          </div>
        </div>
        <div class="acd-foot">
          <div class="acd-err"></div>
          <button class="acd-btn acd-btn-sec" type="button">Cancel</button>
          <button class="acd-btn acd-btn-pri" type="button">Save</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const box = overlay.querySelector(".acd-box");
    const errEl = overlay.querySelector(".acd-err");
    const saveBtn = overlay.querySelector(".acd-btn-pri");
    const cancelBtn = overlay.querySelector(".acd-btn-sec");
    const toolbar = overlay.querySelector(".fd-draw-toolbar");
    const canvas = overlay.querySelector(".fd-draw-canvas");
    const wrapEl = overlay.querySelector(".fd-draw-canvas-wrap");
    overlay.querySelector(".acd-title").textContent = title;

    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext("2d");

    let cssW = 900, cssH = 468;

    // Double-RAF: first frame triggers layout, second reads settled dimensions
    requestAnimationFrame(() => requestAnimationFrame(() => {
      cssW = Math.max(Math.round(wrapEl.getBoundingClientRect().width) || 900, 600);
      cssH = Math.max(Math.round(cssW * 0.52), Math.round(window.innerHeight * 0.6));
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      render();
    }));

    // ── coordinate / snap helpers ───────────────────────────────────────────
    const canvasPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const src = (e.touches && e.touches.length) ? e.touches[0]
        : (e.changedTouches && e.changedTouches.length) ? e.changedTouches[0]
          : e;
      return { x: src.clientX - rect.left, y: src.clientY - rect.top };
    };
    const snap = (v) => Math.round(v / GRID) * GRID;
    const snapPt = (pt) => ({ x: snap(pt.x), y: snap(pt.y) });
    const snapDimPt = (raw) => {
      let best = null, bd = 14;
      for (const s of shapes) {
        if (s.type !== "line") continue;
        for (const [px, py] of [[s.x1, s.y1], [s.x2, s.y2]]) {
          const d = Math.hypot(raw.x - px, raw.y - py);
          if (d < bd) { bd = d; best = { x: px, y: py }; }
        }
      }
      return best || snapPt(raw);
    };

    // ── geometry ────────────────────────────────────────────────────────────
    const arcGeom = (x1, y1, x2, y2, bulge) => {
      const dx = x2 - x1, dy = y2 - y1;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.001 || Math.abs(bulge) < 0.1) return null;
      const s = bulge;
      const halfDist = dist / 2;
      const t = (s * s - halfDist * halfDist) / (2 * s);
      const ux = dx / dist, uy = dy / dist;
      const nx = -uy, ny = ux;
      const cx = x1 + dx / 2 + t * nx;
      const cy = y1 + dy / 2 + t * ny;
      const radius = Math.hypot(x1 - cx, y1 - cy);
      const startAngle = Math.atan2(y1 - cy, x1 - cx);
      const endAngle = Math.atan2(y2 - cy, x2 - cx);
      const counterclockwise = s < 0;
      let sweep = endAngle - startAngle;
      if (counterclockwise && sweep > 0) sweep -= 2 * Math.PI;
      if (!counterclockwise && sweep < 0) sweep += 2 * Math.PI;
      return { cx, cy, radius, startAngle, endAngle, counterclockwise, sweep, s };
    };

    const distSeg = (px, py, ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (!len2) return Math.hypot(px - ax, py - ay);
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      return Math.hypot(px - ax - t * dx, py - ay - t * dy);
    };

    const getBBox = (s) => {
      if (!s) return null;
      if (s.type === "arc") {
        const geom = arcGeom(s.x1, s.y1, s.x2, s.y2, s.bulge);
        if (!geom) return { minX: Math.min(s.x1, s.x2), minY: Math.min(s.y1, s.y2), maxX: Math.max(s.x1, s.x2), maxY: Math.max(s.y1, s.y2) };
        const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
        const dist = Math.hypot(dx, dy);
        const nx = -dy / dist, ny = dx / dist;
        const midX = s.x1 + dx / 2 + s.bulge * nx, midY = s.y1 + dy / 2 + s.bulge * ny;
        const p25X = geom.cx + geom.radius * Math.cos(geom.startAngle + geom.sweep * 0.25);
        const p25Y = geom.cy + geom.radius * Math.sin(geom.startAngle + geom.sweep * 0.25);
        const p75X = geom.cx + geom.radius * Math.cos(geom.startAngle + geom.sweep * 0.75);
        const p75Y = geom.cy + geom.radius * Math.sin(geom.startAngle + geom.sweep * 0.75);
        return {
          minX: Math.min(s.x1, s.x2, midX, p25X, p75X),
          minY: Math.min(s.y1, s.y2, midY, p25Y, p75Y),
          maxX: Math.max(s.x1, s.x2, midX, p25X, p75X),
          maxY: Math.max(s.y1, s.y2, midY, p25Y, p75Y)
        };
      }
      if (s.type === "line" || s.type === "dim") return { minX: Math.min(s.x1, s.x2), minY: Math.min(s.y1, s.y2), maxX: Math.max(s.x1, s.x2), maxY: Math.max(s.y1, s.y2) };
      if (s.type === "rect") return { minX: Math.min(s.x, s.x + s.w), minY: Math.min(s.y, s.y + s.h), maxX: Math.max(s.x, s.x + s.w), maxY: Math.max(s.y, s.y + s.h) };
      if (s.type === "circle") return { minX: s.x - s.r, minY: s.y - s.r, maxX: s.x + s.r, maxY: s.y + s.r };
      if (s.type === "freehand") {
        if (!s.points || !s.points.length) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of s.points) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
        return { minX, minY, maxX, maxY };
      }
      if (s.type === "text") {
        ctx.save(); ctx.font = s.font || "14px sans-serif";
        const m = ctx.measureText(s.text); ctx.restore();
        return { minX: s.x, minY: s.y - 14, maxX: s.x + m.width, maxY: s.y + 4 };
      }
      return null;
    };

    const getGroupBBox = (indices) => {
      if (!indices || !indices.length) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const idx of indices) {
        const bb = getBBox(shapes[idx]);
        if (bb) { if (bb.minX < minX) minX = bb.minX; if (bb.minY < minY) minY = bb.minY; if (bb.maxX > maxX) maxX = bb.maxX; if (bb.maxY > maxY) maxY = bb.maxY; }
      }
      return minX === Infinity ? null : { minX, minY, maxX, maxY };
    };

    const dimGeom = (s) => {
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const nx = -uy, ny = ux;
      const off = typeof s.offset === "number" ? s.offset : 26;
      return {
        len, ux, uy, nx, ny, off,
        ax: s.x1 + nx * off, ay: s.y1 + ny * off,
        bx: s.x2 + nx * off, by: s.y2 + ny * off,
        mx: (s.x1 + s.x2) / 2 + nx * off,
        my: (s.y1 + s.y2) / 2 + ny * off
      };
    };

    const dimText = (lenPx) => {
      const val = (lenPx / displayPxPerMeter) * DRAW_UNITS[scale.unit];
      const rounded = Math.round(val * 100) / 100;
      return `${rounded} ${scale.unit}`;
    };

    const hitShape = (x, y, s, tol = 10) => {
      if (s.type === "arc") {
        const geom = arcGeom(s.x1, s.y1, s.x2, s.y2, s.bulge);
        if (!geom) return distSeg(x, y, s.x1, s.y1, s.x2, s.y2) < tol;
        if (Math.abs(Math.hypot(x - geom.cx, y - geom.cy) - geom.radius) > tol) return false;
        let angle = Math.atan2(y - geom.cy, x - geom.cx);
        let a1 = geom.startAngle, a2 = geom.startAngle + geom.sweep;
        let minA = Math.min(a1, a2), maxA = Math.max(a1, a2);
        while (angle < minA) angle += 2 * Math.PI;
        while (angle > maxA + 2 * Math.PI) angle -= 2 * Math.PI;
        return (angle >= minA && angle <= maxA) || (angle - 2 * Math.PI >= minA && angle - 2 * Math.PI <= maxA);
      }
      if (s.type === "line") return distSeg(x, y, s.x1, s.y1, s.x2, s.y2) < tol;
      if (s.type === "freehand") {
        for (let i = 1; i < s.points.length; i++) {
          const [ax, ay] = s.points[i - 1], [bx, by] = s.points[i];
          if (distSeg(x, y, ax, ay, bx, by) < tol) return true;
        }
        return false;
      }
      if (s.type === "dim") return hitDim(x, y, s).hit;
      if (s.type === "rect") {
        const minX = Math.min(s.x, s.x + s.w), maxX = Math.max(s.x, s.x + s.w);
        const minY = Math.min(s.y, s.y + s.h), maxY = Math.max(s.y, s.y + s.h);
        return x >= minX - tol && x <= maxX + tol && y >= minY - tol && y <= maxY + tol;
      }
      if (s.type === "circle") return Math.hypot(x - s.x, y - s.y) <= s.r + tol;
      if (s.type === "text") {
        const bb = getBBox(s);
        return bb && x >= bb.minX - tol && x <= bb.maxX + tol && y >= bb.minY - tol && y <= bb.maxY + tol;
      }
      return false;
    };

    const hitDim = (x, y, s) => {
      const g = dimGeom(s);
      ctx.save(); ctx.font = "bold 11px sans-serif";
      const tw = ctx.measureText(dimText(g.len)).width; ctx.restore();
      const onLabel = Math.abs(x - g.mx) < tw / 2 + 8 && Math.abs(y - g.my) < 12;
      const onLine = distSeg(x, y, g.ax, g.ay, g.bx, g.by) < 9;
      return { hit: onLabel || onLine, label: onLabel };
    };

    const checkOverlap = (boxSel, s) => {
      const bb = getBBox(s); if (!bb) return false;
      const minX = Math.min(boxSel.x1, boxSel.x2), maxX = Math.max(boxSel.x1, boxSel.x2);
      const minY = Math.min(boxSel.y1, boxSel.y2), maxY = Math.max(boxSel.y1, boxSel.y2);
      return !(bb.minX > maxX || bb.maxX < minX || bb.minY > maxY || bb.maxY < minY);
    };

    // ── rendering ───────────────────────────────────────────────────────────
    const drawArrow = (x, y, ux, uy, c) => {
      const sz = 9, w = 3.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + ux * sz - (-uy) * w, y + uy * sz - ux * w);
      ctx.lineTo(x + ux * sz + (-uy) * w, y + uy * sz + ux * w);
      ctx.closePath(); ctx.fillStyle = c; ctx.fill();
    };

    const drawDim = (s, hl, ghost) => {
      const g = dimGeom(s);
      const c = hl ? "#f39c12" : (s.color || "#1f272e");
      ctx.save(); ctx.globalAlpha = ghost ? 0.5 : 1;
      ctx.strokeStyle = c; ctx.lineWidth = 1.2; ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.x1 + g.nx * 4, s.y1 + g.ny * 4);
      ctx.lineTo(s.x1 + g.nx * (g.off + (g.off >= 0 ? 5 : -5)), s.y1 + g.ny * (g.off + (g.off >= 0 ? 5 : -5)));
      ctx.moveTo(s.x2 + g.nx * 4, s.y2 + g.ny * 4);
      ctx.lineTo(s.x2 + g.nx * (g.off + (g.off >= 0 ? 5 : -5)), s.y2 + g.ny * (g.off + (g.off >= 0 ? 5 : -5)));
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(g.ax, g.ay); ctx.lineTo(g.bx, g.by); ctx.stroke();
      drawArrow(g.ax, g.ay, g.ux, g.uy, c);
      drawArrow(g.bx, g.by, -g.ux, -g.uy, c);
      const text = dimText(g.len);
      ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fillRect(g.mx - tw / 2 - 5, g.my - 9, tw + 10, 18);
      ctx.fillStyle = c; ctx.fillText(text, g.mx, g.my);
      ctx.restore();
    };

    const drawSelectionBox = (bb) => {
      if (!bb) return;
      ctx.save(); ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      const pad = 4;
      ctx.strokeRect(bb.minX - pad, bb.minY - pad, bb.maxX - bb.minX + pad * 2, bb.maxY - bb.minY + pad * 2);
      ctx.setLineDash([]); ctx.fillStyle = "#fff";
      const handles = [[bb.minX - pad, bb.minY - pad], [bb.maxX + pad, bb.minY - pad], [bb.minX - pad, bb.maxY + pad], [bb.maxX + pad, bb.maxY + pad]];
      for (const [hx, hy] of handles) { ctx.fillRect(hx - 4, hy - 4, 8, 8); ctx.strokeRect(hx - 4, hy - 4, 8, 8); }
      ctx.restore();
    };

    const drawShape = (s, hl, ghost) => {
      if (s.type === "dim") { drawDim(s, hl, ghost); return; }
      ctx.save(); ctx.globalAlpha = ghost ? 0.45 : 1;
      ctx.strokeStyle = hl ? "#f39c12" : s.color; ctx.fillStyle = hl ? "#f39c12" : s.color;
      ctx.lineWidth = hl ? 3 : 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (s.type === "line") {
        ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        [[s.x1, s.y1], [s.x2, s.y2]].forEach(([px, py]) => { ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill(); });
      } else if (s.type === "arc") {
        const geom = arcGeom(s.x1, s.y1, s.x2, s.y2, s.bulge);
        if (geom) {
          ctx.beginPath();
          ctx.arc(geom.cx, geom.cy, geom.radius, geom.startAngle, geom.endAngle, geom.counterclockwise);
          ctx.stroke();
        } else {
          ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        }
        [[s.x1, s.y1], [s.x2, s.y2]].forEach(([px, py]) => { ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill(); });
      } else if (s.type === "freehand") {
        ctx.beginPath(); s.points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.stroke();
      } else if (s.type === "rect") {
        ctx.strokeRect(s.x, s.y, s.w, s.h);
        ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, Math.PI * 2); ctx.fill();
      } else if (s.type === "circle") {
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, Math.PI * 2); ctx.fill();
      } else if (s.type === "text") {
        ctx.font = s.font || "14px sans-serif"; ctx.textBaseline = "top"; ctx.fillText(s.text, s.x, s.y);
      }
      if (s.height || s.floors) {
        const bb = getBBox(s);
        if (bb) {
          const label = `${s.height ? s.height + "m" : ""}${s.height && s.floors ? " | " : ""}${s.floors ? s.floors + " fl" : ""}`;
          ctx.font = "bold 10px sans-serif";
          const tw = ctx.measureText(label).width;
          const bx = bb.maxX - tw, by = bb.maxY + 6;
          ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fillRect(bx - 4, by - 2, tw + 8, 14);
          ctx.fillStyle = s.color || "#1f272e"; ctx.fillText(label, bx, by + 9);
        }
      }
      ctx.restore();
    };

    const render = (ghost) => {
      ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cssW, cssH);
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cssW, cssH);
      ctx.fillStyle = "#d0d5dd";
      for (let gx = 0; gx <= cssW; gx += GRID) for (let gy = 0; gy <= cssH; gy += GRID) { ctx.beginPath(); ctx.arc(gx, gy, 1.3, 0, Math.PI * 2); ctx.fill(); }
      shapes.forEach((s, i) => drawShape(s, i === _valShapeIdx || selectedShapeIndices.includes(i), false));
      if (ghost) drawShape(ghost, false, true);
      if (selectedShapeIndices.length > 0) drawSelectionBox(getGroupBBox(selectedShapeIndices));
      if (boxSelectDraft) {
        ctx.save(); ctx.fillStyle = "rgba(37,99,235,0.12)"; ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        const x = Math.min(boxSelectDraft.x1, boxSelectDraft.x2), y = Math.min(boxSelectDraft.y1, boxSelectDraft.y2);
        const w = Math.abs(boxSelectDraft.x2 - boxSelectDraft.x1), h = Math.abs(boxSelectDraft.y2 - boxSelectDraft.y1);
        ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); ctx.restore();
      }

      if (arcDraft) {
        if (Math.abs(arcDraft.bulge) > 2) {
          drawShape({ type: "arc", x1: arcDraft.startX, y1: arcDraft.startY, x2: arcDraft.endX, y2: arcDraft.endY, bulge: arcDraft.bulge, color: "#2563eb" }, false, false);
          const geom = arcGeom(arcDraft.startX, arcDraft.startY, arcDraft.endX, arcDraft.endY, arcDraft.bulge);
          if (geom) {
            const deg = Math.round(Math.abs(geom.sweep) * 180 / Math.PI) + "°";
            const dx = arcDraft.endX - arcDraft.startX, dy = arcDraft.endY - arcDraft.startY;
            const dist = Math.hypot(dx, dy);
            const nx = -dy / dist, ny = dx / dist;
            const midX = arcDraft.startX + dx / 2 + arcDraft.bulge * nx;
            const midY = arcDraft.startY + dy / 2 + arcDraft.bulge * ny;
            ctx.save(); ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#2563eb";
            ctx.fillText(deg, midX + nx * 14, midY + ny * 14); ctx.restore();
          }
        } else {
          drawShape({ type: "line", x1: arcDraft.startX, y1: arcDraft.startY, x2: arcDraft.endX, y2: arcDraft.endY, color: "#2563eb" }, false, false);
        }
      } else if (tool === "line" && chainStart) {
        ctx.beginPath(); ctx.arc(chainStart.x, chainStart.y, 5, 0, Math.PI * 2);
        ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 1.5; ctx.stroke();
      }

      ctx.restore();
    };

    // ── scale animation ─────────────────────────────────────────────────────
    const animateScaleTo = (target) => {
      if (scaleAnimFrame) cancelAnimationFrame(scaleAnimFrame);
      const start = displayPxPerMeter, t0 = performance.now(), dur = 420;
      scale.pxPerMeter = target;   // commit up front — a Save mid-tween must persist the new scale
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        displayPxPerMeter = start + (target - start) * (1 - Math.pow(1 - k, 3));
        render();
        if (k < 1) { scaleAnimFrame = requestAnimationFrame(step); }
        else { displayPxPerMeter = target; scaleAnimFrame = null; render(); }
      };
      scaleAnimFrame = requestAnimationFrame(step);
    };

    // ── overlays ────────────────────────────────────────────────────────────
    const removeOverlayInputs = () => {
      if (_valInputEl && _valInputEl.parentNode) _valInputEl.parentNode.removeChild(_valInputEl);
      if (textInputEl && textInputEl.parentNode) textInputEl.parentNode.removeChild(textInputEl);
      _valInputEl = null; _valShapeIdx = null; textInputEl = null;
    };

    const showValInput = (idx) => {
      removeOverlayInputs(); _valShapeIdx = idx;
      const s = shapes[idx], g = dimGeom(s);
      const inp = document.createElement("input");
      inp.type = "text"; inp.inputMode = "decimal"; inp.placeholder = "e.g. 2.5";
      inp.value = String(Math.round((g.len / displayPxPerMeter) * DRAW_UNITS[scale.unit] * 100) / 100);
      inp.style.cssText = `position:absolute;left:${g.mx - 42}px;top:${g.my - 14}px;width:84px;font-size:12px;font-weight:600;border:2px solid #f39c12;border-radius:5px;padding:2px 4px;text-align:center;background:#fffbe6;color:#333;box-shadow:0 2px 8px rgba(0,0,0,.22);z-index:20;`;
      wrapEl.style.position = "relative"; wrapEl.appendChild(inp); _valInputEl = inp; inp.focus(); inp.select();
      const commit = () => {
        const v = parseFloat(inp.value), wasIdx = _valShapeIdx;
        removeOverlayInputs();
        if (wasIdx !== null && shapes[wasIdx] && !isNaN(v) && v > 0) {
          animateScaleTo(dimGeom(shapes[wasIdx]).len / (v / DRAW_UNITS[scale.unit]));
        } else { render(); }
      };
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.stopPropagation(); commit(); } if (e.key === "Escape") { e.stopPropagation(); removeOverlayInputs(); render(); } });
      inp.addEventListener("blur", commit);
      render();
    };

    const showTextInput = (x, y) => {
      removeOverlayInputs(); hidePropsPanel(); selectedShapeIndices = [];
      const inp = document.createElement("input");
      inp.type = "text"; inp.placeholder = "Enter text...";
      inp.style.cssText = `position:absolute;left:${x}px;top:${y - 10}px;font-size:14px;font-family:sans-serif;border:1px solid #2563eb;border-radius:4px;padding:4px 6px;background:#fff;z-index:20;outline:none;`;
      wrapEl.style.position = "relative"; wrapEl.appendChild(inp); textInputEl = inp; inp.focus();
      const commit = () => {
        const val = inp.value.trim(); removeOverlayInputs();
        if (val) { saveState(); shapes.push({ type: "text", text: val, x, y, font: "14px sans-serif", color }); }
        render();
      };
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.stopPropagation(); commit(); } if (e.key === "Escape") { e.stopPropagation(); removeOverlayInputs(); render(); } });
      inp.addEventListener("blur", commit);
    };

    const hidePropsPanel = () => {
      if (propsPanelEl && propsPanelEl.parentNode) propsPanelEl.parentNode.removeChild(propsPanelEl);
      propsPanelEl = null;
    };

    const showPropsPanel = () => {
      hidePropsPanel();
      if (selectedShapeIndices.length !== 1) return;
      const idx = selectedShapeIndices[0], s = shapes[idx];
      if (!s) return;
      const bb = getBBox(s); if (!bb) return;
      const panel = document.createElement("div");
      panel.style.cssText = `position:absolute;left:${bb.maxX + 15}px;top:${bb.minY}px;background:#fff;border:1px solid #e2e6ea;border-radius:8px;padding:10px;box-shadow:0 4px 12px rgba(0,0,0,0.1);z-index:30;display:flex;flex-direction:column;gap:8px;width:160px;font-size:12px;`;
      panel.innerHTML = `<div style="font-weight:600;margin-bottom:2px;">Region Properties</div><div style="display:flex;justify-content:space-between;align-items:center;"><label style="margin:0;color:#8d96a0;">Height (m)</label><input type="number" class="fd-prop-h" value="${s.height || ""}" style="width:60px;padding:2px 4px;border:1px solid #e2e6ea;border-radius:4px;" step="any"></div><div style="display:flex;justify-content:space-between;align-items:center;"><label style="margin:0;color:#8d96a0;">Floors</label><input type="number" class="fd-prop-f" value="${s.floors || ""}" style="width:60px;padding:2px 4px;border:1px solid #e2e6ea;border-radius:4px;"></div>`;
      wrapEl.style.position = "relative"; wrapEl.appendChild(panel); propsPanelEl = panel;
      const hIn = panel.querySelector(".fd-prop-h"), fIn = panel.querySelector(".fd-prop-f");
      let propsSaveTriggered = false;
      const updateProps = () => {
        if (!shapes[idx]) return;
        if (!propsSaveTriggered) { saveState(); propsSaveTriggered = true; }
        shapes[idx].height = hIn.value ? parseFloat(hIn.value) : null;
        shapes[idx].floors = fIn.value ? parseInt(fIn.value, 10) : null;
        render();
      };
      hIn.addEventListener("focus", () => { propsSaveTriggered = false; });
      fIn.addEventListener("focus", () => { propsSaveTriggered = false; });
      hIn.addEventListener("input", updateProps);
      fIn.addEventListener("input", updateProps);
    };

    // ── pointer events ──────────────────────────────────────────────────────
    function checkHandleHit(x, y, bb) {
      if (!bb) return null;
      const pad = 4;
      for (const h of [{ id: "tl", x: bb.minX - pad, y: bb.minY - pad }, { id: "tr", x: bb.maxX + pad, y: bb.minY - pad }, { id: "bl", x: bb.minX - pad, y: bb.maxY + pad }, { id: "br", x: bb.maxX + pad, y: bb.maxY + pad }]) {
        if (x >= h.x - 8 && x <= h.x + 8 && y >= h.y - 8 && y <= h.y + 8) return h.id;
      }
      return null;
    }

    function applyTransform(s, origS, state, dx, dy, shiftKey) {
      if (state.mode === "move") {
        if (s.type === "rect" || s.type === "circle" || s.type === "text") { s.x = origS.x + dx; s.y = origS.y + dy; }
        else if (s.type === "line" || s.type === "dim" || s.type === "arc") { s.x1 = origS.x1 + dx; s.y1 = origS.y1 + dy; s.x2 = origS.x2 + dx; s.y2 = origS.y2 + dy; }
        else if (s.type === "freehand") { s.points = origS.points.map(p => [p[0] + dx, p[1] + dy]); }
      } else if (state.mode === "scale") {
        const bb = state.groupBB; if (!bb) return;
        let nMinX = bb.minX, nMinY = bb.minY, nMaxX = bb.maxX, nMaxY = bb.maxY;
        if (state.handle.includes("l")) nMinX += dx;
        if (state.handle.includes("r")) nMaxX += dx;
        if (state.handle.includes("t")) nMinY += dy;
        if (state.handle.includes("b")) nMaxY += dy;
        if (nMaxX < nMinX) { const t = nMinX; nMinX = nMaxX; nMaxX = t; }
        if (nMaxY < nMinY) { const t = nMinY; nMinY = nMaxY; nMaxY = t; }
        let scaleX = (nMaxX - nMinX) / (bb.maxX - bb.minX || 1);
        let scaleY = (nMaxY - nMinY) / (bb.maxY - bb.minY || 1);
        if (shiftKey) {
          const sVal = Math.max(Math.abs(scaleX), Math.abs(scaleY));
          scaleX = scaleX < 0 ? -sVal : sVal; scaleY = scaleY < 0 ? -sVal : sVal;
          if (state.handle.includes("l")) nMinX = bb.maxX - (bb.maxX - bb.minX) * Math.abs(scaleX); else nMaxX = bb.minX + (bb.maxX - bb.minX) * Math.abs(scaleX);
          if (state.handle.includes("t")) nMinY = bb.maxY - (bb.maxY - bb.minY) * Math.abs(scaleY); else nMaxY = bb.minY + (bb.maxY - bb.minY) * Math.abs(scaleY);
        }

        if (s.type === "rect") { s.x = nMinX + (origS.x - bb.minX) * scaleX; s.y = nMinY + (origS.y - bb.minY) * scaleY; s.w = origS.w * scaleX; s.h = origS.h * scaleY; }
        else if (s.type === "circle") { s.x = nMinX + (origS.x - bb.minX) * scaleX; s.y = nMinY + (origS.y - bb.minY) * scaleY; s.r = origS.r * Math.max(Math.abs(scaleX), Math.abs(scaleY)); }
        else if (s.type === "line" || s.type === "dim" || s.type === "arc") {
          s.x1 = nMinX + (origS.x1 - bb.minX) * scaleX; s.y1 = nMinY + (origS.y1 - bb.minY) * scaleY;
          s.x2 = nMinX + (origS.x2 - bb.minX) * scaleX; s.y2 = nMinY + (origS.y2 - bb.minY) * scaleY;
          if (s.type === "arc") {
            const flip = (scaleX < 0 ? -1 : 1) * (scaleY < 0 ? -1 : 1);
            s.bulge = origS.bulge * ((Math.abs(scaleX) + Math.abs(scaleY)) / 2) * flip;
          }
        }
        else if (s.type === "freehand") { s.points = origS.points.map(p => [nMinX + (p[0] - bb.minX) * scaleX, nMinY + (p[1] - bb.minY) * scaleY]); }
        else if (s.type === "text") { s.x = nMinX + (origS.x - bb.minX) * scaleX; s.y = nMinY + (origS.y - bb.minY) * scaleY; }
      }
    }

    function onDown(e) {
      e.preventDefault();
      const raw = canvasPos(e); downPos = raw; pointerMoved = false; pointerDown = true;
      removeOverlayInputs();

      if (tool === "select") {
        let hitGroupBB = false, groupBB = null;
        if (selectedShapeIndices.length > 0) {
          groupBB = getGroupBBox(selectedShapeIndices);
          const handle = checkHandleHit(raw.x, raw.y, groupBB);
          if (handle) { transformState = { mode: "scale", handle, startX: raw.x, startY: raw.y, origShapes: selectedShapeIndices.map(i => JSON.parse(JSON.stringify(shapes[i]))), groupBB, saved: false }; return; }
          if (!e.shiftKey && groupBB && raw.x >= groupBB.minX && raw.x <= groupBB.maxX && raw.y >= groupBB.minY && raw.y <= groupBB.maxY) hitGroupBB = true;
        }
        let hitIdx = null;
        for (let i = shapes.length - 1; i >= 0; i--) { if (hitShape(raw.x, raw.y, shapes[i])) { hitIdx = i; break; } }
        if (e.shiftKey && hitIdx !== null) {
          const pos = selectedShapeIndices.indexOf(hitIdx);
          if (pos === -1) selectedShapeIndices.push(hitIdx); else selectedShapeIndices.splice(pos, 1);
          showPropsPanel(); render(); return;
        }
        if ((hitGroupBB && hitIdx === null) || (hitIdx !== null && selectedShapeIndices.includes(hitIdx))) {
          transformState = { mode: "move", startX: raw.x, startY: raw.y, origShapes: selectedShapeIndices.map(i => JSON.parse(JSON.stringify(shapes[i]))), saved: false }; return;
        }
        if (hitIdx !== null) {
          selectedShapeIndices = [hitIdx]; showPropsPanel();
          transformState = { mode: "move", startX: raw.x, startY: raw.y, origShapes: [JSON.parse(JSON.stringify(shapes[hitIdx]))], saved: false };
          render(); return;
        }
        if (!e.shiftKey) { selectedShapeIndices = []; hidePropsPanel(); }
        boxSelectDraft = { x1: raw.x, y1: raw.y, x2: raw.x, y2: raw.y }; render(); return;
      }

      selectedShapeIndices = []; hidePropsPanel();

      if (tool === "measure") {
        for (let i = shapes.length - 1; i >= 0; i--) {
          if (shapes[i].type !== "dim") continue;
          const h = hitDim(raw.x, raw.y, shapes[i]);
          if (h.hit) { dimDragIdx = i; dimHitWasLabel = h.label; return; }
        }
        for (let i = shapes.length - 1; i >= 0; i--) {
          const s = shapes[i];
          if ((s.type === "rect" || s.type === "circle" || s.type === "line" || s.type === "arc") && hitShape(raw.x, raw.y, s)) {
            saveState();
            if (s.type === "rect") { shapes.push({ type: "dim", x1: s.x, y1: s.y, x2: s.x + s.w, y2: s.y, offset: -26, color }); shapes.push({ type: "dim", x1: s.x + s.w, y1: s.y, x2: s.x + s.w, y2: s.y + s.h, offset: 26, color }); }
            else if (s.type === "circle") { shapes.push({ type: "dim", x1: s.x, y1: s.y, x2: s.x + s.r, y2: s.y, offset: -26, color }); }
            else if (s.type === "line" || s.type === "arc") { shapes.push({ type: "dim", x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, offset: 26, color }); }
            render(); return;
          }
        }
        dimDraft = snapDimPt(raw); return;
      }

      if (tool === "eraser") {
        eraseMode = true; eraseModeSaved = false;
        for (let i = shapes.length - 1; i >= 0; i--) { if (hitShape(raw.x, raw.y, shapes[i])) { if (!eraseModeSaved) { saveState(); eraseModeSaved = true; } shapes.splice(i, 1); render(); return; } }
        return;
      }
      if (tool === "line") {
        if (!chainStart) { chainStart = snapPt(raw); anchorJustPlaced = true; render(); }
        else {
          const end = snapPt(raw);
          const d = Math.hypot(end.x - chainStart.x, end.y - chainStart.y);
          if (d > 2) { arcDraft = { startX: chainStart.x, startY: chainStart.y, endX: end.x, endY: end.y, bulge: 0 }; }
          else if (!anchorJustPlaced) { chainStart = null; }
          render();
        }
        return;
      }
      if (tool === "rect") { draftShape = { type: "rect", x: snap(raw.x), y: snap(raw.y), w: 0, h: 0, color }; return; }
      if (tool === "circle") { draftShape = { type: "circle", x: snap(raw.x), y: snap(raw.y), r: 0, color }; return; }
      if (tool === "text") { showTextInput(raw.x, raw.y); return; }
      if (tool === "freehand") { freeDrawing = true; freePoints = [[raw.x, raw.y]]; }
    }

    function onMove(e) {
      const raw = canvasPos(e);
      if (pointerDown && downPos && Math.hypot(raw.x - downPos.x, raw.y - downPos.y) > 4) pointerMoved = true;

      if (tool === "select" && boxSelectDraft && pointerDown) { e.preventDefault(); boxSelectDraft.x2 = raw.x; boxSelectDraft.y2 = raw.y; render(); return; }
      if (tool === "select" && transformState && selectedShapeIndices.length > 0 && pointerDown) {
        e.preventDefault();
        if (!transformState.saved && pointerMoved) { saveState(); transformState.saved = true; }
        selectedShapeIndices.forEach((idx, arrIdx) => applyTransform(shapes[idx], transformState.origShapes[arrIdx], transformState, raw.x - transformState.startX, raw.y - transformState.startY, e.shiftKey));
        render();
        if (propsPanelEl && selectedShapeIndices.length === 1) {
          const bb = getBBox(shapes[selectedShapeIndices[0]]);
          if (bb) { propsPanelEl.style.left = `${bb.maxX + 15}px`; propsPanelEl.style.top = `${bb.minY}px`; }
        }
        return;
      }
      if (tool === "eraser" && eraseMode && pointerDown) {
        e.preventDefault();
        let erased = false;
        for (let i = shapes.length - 1; i >= 0; i--) { if (hitShape(raw.x, raw.y, shapes[i])) { if (!eraseModeSaved) { saveState(); eraseModeSaved = true; } shapes.splice(i, 1); erased = true; } }
        if (erased) render();
        return;
      }
      if (tool === "line") {
        e.preventDefault();
        if (arcDraft && pointerDown) {
          const dx = arcDraft.endX - arcDraft.startX, dy = arcDraft.endY - arcDraft.startY;
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len, ny = dx / len;
          const dragX = raw.x - arcDraft.endX, dragY = raw.y - arcDraft.endY;
          arcDraft.bulge = dragX * nx + dragY * ny;
          render(); return;
        }
        if (chainStart) { render({ type: "line", x1: chainStart.x, y1: chainStart.y, x2: snapPt(raw).x, y2: snapPt(raw).y, color, measurement: "" }); return; }
      }
      if (tool === "rect" && draftShape && pointerDown) { e.preventDefault(); const pt = snapPt(raw); draftShape.w = pt.x - draftShape.x; draftShape.h = pt.y - draftShape.y; render(draftShape); return; }
      if (tool === "circle" && draftShape && pointerDown) { e.preventDefault(); const pt = snapPt(raw); draftShape.r = Math.hypot(pt.x - draftShape.x, pt.y - draftShape.y); render(draftShape); return; }
      if (tool === "measure") {
        if (dimDragIdx !== null && pointerDown) {
          e.preventDefault();
          if (pointerMoved && !(transformState && transformState.saved)) { saveState(); transformState = { saved: true }; }
          const s = shapes[dimDragIdx], g = dimGeom(s);
          s.offset = (raw.x - s.x1) * g.nx + (raw.y - s.y1) * g.ny; render(); return;
        }
        if (dimDraft && pointerDown) { e.preventDefault(); const pt = snapDimPt(raw); render({ type: "dim", x1: dimDraft.x, y1: dimDraft.y, x2: pt.x, y2: pt.y, offset: 26, color }); return; }
        return;
      }
      if (tool === "freehand" && freeDrawing) { e.preventDefault(); freePoints.push([raw.x, raw.y]); render({ type: "freehand", points: freePoints, color }); }
    }

    function onUp(e) {
      const raw = canvasPos(e); pointerDown = false; eraseMode = false; eraseModeSaved = false;
      if (tool === "select" && boxSelectDraft) {
        for (let i = 0; i < shapes.length; i++) { if (checkOverlap(boxSelectDraft, shapes[i]) && !selectedShapeIndices.includes(i)) selectedShapeIndices.push(i); }
        boxSelectDraft = null; showPropsPanel(); render(); return;
      }
      if (tool === "select" && transformState) { transformState = null; return; }
      if (tool === "line") {
        if (arcDraft) {
          saveState();
          if (Math.abs(arcDraft.bulge) > 2) {
            shapes.push({ type: "arc", x1: arcDraft.startX, y1: arcDraft.startY, x2: arcDraft.endX, y2: arcDraft.endY, bulge: arcDraft.bulge, color });
          } else {
            shapes.push({ type: "line", x1: arcDraft.startX, y1: arcDraft.startY, x2: arcDraft.endX, y2: arcDraft.endY, color, measurement: "" });
          }
          chainStart = { x: arcDraft.endX, y: arcDraft.endY };
          arcDraft = null; anchorJustPlaced = false; render(); return;
        }
        anchorJustPlaced = false; render(); return;
      }
      if ((tool === "rect" || tool === "circle") && draftShape) {
        if ((tool === "rect" && Math.abs(draftShape.w) > 2 && Math.abs(draftShape.h) > 2) || (tool === "circle" && draftShape.r > 2)) {
          saveState();
          if (draftShape.type === "rect") { if (draftShape.w < 0) { draftShape.x += draftShape.w; draftShape.w = Math.abs(draftShape.w); } if (draftShape.h < 0) { draftShape.y += draftShape.h; draftShape.h = Math.abs(draftShape.h); } }
          shapes.push(draftShape);
        }
        draftShape = null; render(); return;
      }
      if (tool === "measure") {
        if (dimDragIdx !== null) { const idx = dimDragIdx; dimDragIdx = null; transformState = null; if (!pointerMoved && dimHitWasLabel) showValInput(idx); else render(); return; }
        if (dimDraft) {
          const end = snapDimPt(raw);
          if (Math.hypot(end.x - dimDraft.x, end.y - dimDraft.y) > 4) { saveState(); shapes.push({ type: "dim", x1: dimDraft.x, y1: dimDraft.y, x2: end.x, y2: end.y, offset: 26, color }); }
          dimDraft = null; render(); return;
        }
        return;
      }
      if (tool === "freehand" && freeDrawing) {
        freeDrawing = false;
        if (freePoints.length > 1) { saveState(); shapes.push({ type: "freehand", points: [...freePoints], color }); }
        freePoints = []; render();
      }
    }

    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseup", onUp);
    canvas.addEventListener("mouseleave", () => { if (freeDrawing) { freeDrawing = false; render(); } eraseMode = false; eraseModeSaved = false; });
    canvas.addEventListener("touchstart", onDown, { passive: false });
    canvas.addEventListener("touchmove", onMove, { passive: false });
    canvas.addEventListener("touchend", onUp, { passive: false });
    canvas.addEventListener("dblclick", (e) => { e.preventDefault(); if (chainStart) { chainStart = null; render(); } });
    canvas.addEventListener("contextmenu", (e) => { e.preventDefault(); if (chainStart) { chainStart = null; render(); } });
    canvas.style.cursor = "crosshair";

    // ── undo / redo ─────────────────────────────────────────────────────────
    const resetDrafts = () => {
      chainStart = null; draftShape = null; arcDraft = null; dimDraft = null; dimDragIdx = null;
      selectedShapeIndices = []; transformState = null; boxSelectDraft = null;
      removeOverlayInputs(); hidePropsPanel();
    };

    const _undo = () => {
      if (!history.length) return;
      redoStack.push(JSON.stringify(shapes));
      shapes = JSON.parse(history.pop());
      resetDrafts(); render();
    };

    const _redo = () => {
      if (!redoStack.length) return;
      history.push(JSON.stringify(shapes));
      shapes = JSON.parse(redoStack.pop());
      resetDrafts(); render();
    };

    // ── close / save ────────────────────────────────────────────────────────
    let closed = false;
    let saving = false;

    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", keydownHandler, true);
      if (scaleAnimFrame) cancelAnimationFrame(scaleAnimFrame);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      _isOpen = false;
      if (typeof onClose === "function") onClose();
    };

    const showErr = (msg) => {
      errEl.textContent = msg || "";
      errEl.style.display = msg ? "block" : "none";
    };

    const doSave = async () => {
      if (saving) return;
      saving = true;
      showErr("");
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      cancelBtn.disabled = true;
      try {
        const payload = JSON.stringify({ version: 3, shapes, scale: { pxPerMeter: scale.pxPerMeter, unit: scale.unit } });
        if (typeof onSave === "function") await onSave(payload, shapes.length > 0);
        close();
      } catch (err) {
        saving = false;
        saveBtn.disabled = false; saveBtn.textContent = "Save";
        cancelBtn.disabled = false;
        showErr((err && err.message) || String(err) || "Save failed.");
      }
    };

    // Capture phase so the canvas shortcuts win over anything underneath.
    function keydownHandler(e) {
      const tag = document.activeElement && document.activeElement.tagName.toLowerCase();
      const inInput = tag === "input" || tag === "textarea" || tag === "select";
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key === "z" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); _undo(); return; }
      if (ctrl && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); e.stopPropagation(); _redo(); return; }

      if ((e.key === "Delete" || e.key === "Backspace") && tool === "select" && selectedShapeIndices.length > 0) {
        if (!inInput) {
          e.preventDefault(); e.stopPropagation();
          saveState();
          [...selectedShapeIndices].sort((a, b) => b - a).forEach(i => shapes.splice(i, 1));
          selectedShapeIndices = []; hidePropsPanel(); render();
        }
      }
      if (e.key === "Escape") {
        // let the inline text/value inputs handle their own Escape first
        if (document.activeElement === textInputEl || document.activeElement === _valInputEl) return;
        e.preventDefault(); e.stopPropagation();
        if (chainStart) { chainStart = null; render(); return; }
        if (!saving) close();
      }
    }
    document.addEventListener("keydown", keydownHandler, true);

    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay && !saving) close(); });
    box.querySelector(".acd-x").addEventListener("click", () => { if (!saving) close(); });
    cancelBtn.addEventListener("click", () => { if (!saving) close(); });
    saveBtn.addEventListener("click", doSave);

    // ── toolbar (delegated) ─────────────────────────────────────────────────
    toolbar.addEventListener("click", (e) => {
      const toolBtn = e.target.closest(".fd-draw-tool[data-tool]");
      if (toolBtn) {
        tool = toolBtn.getAttribute("data-tool");
        resetDrafts();
        toolbar.querySelectorAll(".fd-draw-tool[data-tool]").forEach(b => b.classList.remove("fd-draw-tool--active"));
        toolBtn.classList.add("fd-draw-tool--active");
        canvas.style.cursor = tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";
        render();
        return;
      }

      const colorBtn = e.target.closest(".fd-draw-color-btn");
      if (colorBtn) {
        color = colorBtn.getAttribute("data-color");
        toolbar.querySelectorAll(".fd-draw-color-btn").forEach(b => b.classList.remove("fd-draw-color-active"));
        colorBtn.classList.add("fd-draw-color-active");
        if (tool === "select" && selectedShapeIndices.length > 0) {
          saveState();
          for (const idx of selectedShapeIndices) { if (shapes[idx]) shapes[idx].color = color; }
          render();
        }
        return;
      }

      if (e.target.closest(".fd-draw-undo-btn")) { _undo(); return; }
      if (e.target.closest(".fd-draw-redo-btn")) { _redo(); return; }

      if (e.target.closest(".fd-draw-clear-btn")) {
        if (!shapes.length || window.confirm("Clear all? Cannot be undone.")) {
          saveState(); shapes = [];
          resetDrafts(); render();
        }
      }
    });

    toolbar.addEventListener("change", (e) => {
      const sel = e.target.closest(".fd-draw-unit");
      if (sel) { scale.unit = sel.value; render(); }
    });
  }

  // ── styles (injected once) ────────────────────────────────────────────────
  function _inject_styles() {
    if (_styled || document.getElementById("acd-draw-styles")) { _styled = true; return; }
    _styled = true;
    const style = Object.assign(document.createElement("style"), { id: "acd-draw-styles" });
    style.textContent = `
      .acd-overlay {
        position:fixed; inset:0; z-index:2147482500; display:flex;
        align-items:center; justify-content:center; padding:24px;
        background:rgba(15,35,75,.58); backdrop-filter:blur(4px);
        font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; color:#1d1d1f;
      }
      .acd-box {
        display:flex; flex-direction:column; overflow:hidden;
        width:min(1100px, calc(100vw - 32px)); max-height:calc(100vh - 48px);
        background:#fff; border:1px solid #cbd9f1; border-radius:18px;
        box-shadow:0 28px 80px rgba(15,35,75,.32);
      }
      .acd-head {
        display:flex; align-items:center; gap:12px; padding:14px 18px;
        background:linear-gradient(135deg,#1e3f85,#284f9e); color:#fff;
      }
      .acd-title { flex:1; font-size:15px; font-weight:700; }
      .acd-x {
        display:inline-flex; align-items:center; justify-content:center;
        width:28px; height:28px; padding:0; border:0; border-radius:50%;
        background:#fff; color:#1e3f85; cursor:pointer; line-height:1;
        transition:background .15s, color .15s, box-shadow .15s;
      }
      .acd-x:hover { background:#fee2e2; color:#dc2626; box-shadow:0 0 0 3px rgba(254,202,202,.55); }
      .acd-body { flex:1; min-height:0; overflow:auto; background:#fff; }
      .acd-foot {
        display:flex; align-items:center; justify-content:flex-end; gap:10px;
        padding:12px 18px; background:#fff; border-top:1px solid #dce6f5;
      }
      .acd-err { flex:1; display:none; color:#ba0517; font-size:12px; font-weight:600; }
      .acd-btn {
        height:34px; padding:0 20px; border-radius:99px; font:inherit; font-size:13px;
        font-weight:600; cursor:pointer; transition:opacity .12s, background .12s;
      }
      .acd-btn:disabled { opacity:.6; cursor:default; }
      .acd-btn-pri { background:#1e3f85; color:#fff; border:1px solid #1e3f85; }
      .acd-btn-pri:hover:not(:disabled) { background:#284f9e; }
      .acd-btn-sec { background:#fff; color:#1e3f85; border:1px solid #cbd9f1; }
      .acd-btn-sec:hover:not(:disabled) { background:#eff4fd; }

      .fd-draw-dialog { display:flex; flex-direction:column; overflow:hidden; }
      .fd-draw-toolbar {
        display:flex; align-items:center; justify-content:space-between;
        padding:8px 14px; background:#fff;
        border-bottom:1.5px solid #e8e8f0; flex-wrap:wrap; gap:6px;
      }
      .fd-draw-tools { display:flex; align-items:center; gap:3px; flex-wrap:wrap; }
      .fd-draw-tool {
        display:inline-flex; align-items:center; justify-content:center;
        width:30px; height:30px; border:1px solid #e8e8f0; border-radius:99px;
        background:transparent; cursor:pointer; color:#64748b;
        transition:background .12s, border-color .12s, color .12s;
      }
      .fd-draw-tool:hover    { background:#f1f5f9; border-color:#cbd5e1; color:#1e293b; }
      .fd-draw-tool--active  { background:#eff6ff; border-color:#bfdbfe; color:#2563eb; }
      .fd-draw-sep           { width:1px; height:18px; background:#e8e8f0; margin:0 3px; }
      .fd-draw-swatch        { display:block; width:13px; height:13px; border-radius:50%; box-shadow:0 0 0 1.5px rgba(0,0,0,0.12); }
      .fd-draw-color-active .fd-draw-swatch { box-shadow:0 0 0 2px #2563eb; }
      .fd-draw-unit-label    { font-size:11px; font-weight:600; color:#94a3b8; letter-spacing:.03em; white-space:nowrap; }
      .fd-draw-unit {
        height:28px; border:1px solid #e8e8f0; border-radius:99px;
        padding:0 10px; font-size:12px; cursor:pointer;
        background:#f8fafc; color:#374151; font-weight:500;
        transition:border-color .12s;
      }
      .fd-draw-unit:focus { outline:none; border-color:#2563eb; }
      .fd-draw-undo-btn, .fd-draw-redo-btn, .fd-draw-clear-btn {
        height:28px; padding:0 12px; border:1px solid #e8e8f0;
        border-radius:99px; background:transparent; cursor:pointer; font-size:12px;
        color:#64748b; display:inline-flex; align-items:center; gap:5px; font-weight:500;
        font-family:inherit;
        transition:background .12s, border-color .12s, color .12s;
      }
      .fd-draw-undo-btn:hover, .fd-draw-redo-btn:hover { background:#f1f5f9; border-color:#cbd5e1; color:#1e293b; }
      .fd-draw-clear-btn:hover { background:#fff1f2; border-color:#fecdd3; color:#e11d48; }
      .fd-draw-canvas-wrap { position:relative; overflow:hidden; width:100%; min-height:60vh; background:#fff; }
      .fd-draw-canvas      { display:block; cursor:crosshair; touch-action:none; }
    `;
    document.head.appendChild(style);
  }

  return { open };
})();
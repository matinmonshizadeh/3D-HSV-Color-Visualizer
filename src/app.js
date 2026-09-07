/* ==========================================================================
 * 3D HSV Color Visualizer - src/app.js
 *
 * A zero-dependency visualisation of the HSV colour space as a 3D cone,
 * rendered with the 2D canvas API. The orbit camera, the world-to-view
 * transform, the perspective projection and the HSV->RGB conversion are
 * all written by hand; no libraries are used.
 *
 * World space is right-handed with +y up. The cone stands on its apex:
 *   apex  (V = 0,   black)  at the origin
 *   disc  (V = 255, bright) at y = HEIGHT, radius RADIUS
 * A colour (H, S, V) maps to the point
 *   theta = H (degrees), y = V / 255 * HEIGHT, r = S / 255 * RADIUS * V / 255
 *
 * Sections
 *   1. State       - DOM handles, constants, camera and UI state
 *   2. Camera      - orbit camera and look-at basis
 *   3. Projection  - world -> view -> screen, near-plane handling
 *   4. Colour      - HSV -> RGB, hex formatting, hue-mode conversion
 *   5. Drawing     - cone mesh, painter's sort, marker, axis guides
 *   6. Events      - sliders, number inputs, hue mode, pointer orbit, resize
 *   7. Init
 * ========================================================================== */
"use strict";

/* ---------------------------------------------------------------- 1. State */

const $ = (id) => document.getElementById(id);

const ui = {
  hue: $("hue"),
  sat: $("sat"),
  val: $("val"),
  hueVal: $("hueVal"),
  satVal: $("satVal"),
  valVal: $("valVal"),
  hueUnit: $("hueUnit"),
  hueMode: $("hueMode"),
  colorBox: $("colorBox"),
  hexDisplay: $("hexDisplay"),
};

const canvas = $("hsvCone");
const ctx = canvas.getContext("2d");

/* Cone geometry (world units) */
const RADIUS = 150;                           // radius of the top disc (S = 255)
const HEIGHT = 250;                           // apex at y = 0, disc at y = HEIGHT
const TARGET = { x: 0, y: HEIGHT / 2, z: 0 }; // orbit centre
const WORLD_UP = { x: 0, y: 1, z: 0 };
const DISC_NORMAL = { x: 0, y: 1, z: 0 };

/* Mesh resolution */
const STEPS_H = 48;                           // hue segments around the cone
const STEPS_V = 24;                           // rings along the height
const STEPS_S = 8;                            // saturation rings across the disc

/* Projection */
const FOCAL = 450;                            // focal length (px) for a 400 px viewport
const REF_SIZE = 400;                         // viewport size the focal length is tuned for
const NEAR = 1;                               // near plane (view units); nothing closer is drawn

/* Camera */
const MAX_ELEVATION = Math.PI / 2 - 0.05;     // keeps the camera off the poles
const ORBIT_SPEED = 0.008;                    // radians per pixel of drag on a 400 px canvas (about 1:1 grab)
const SMOOTHING = 0.35;                       // fraction of the remaining drag distance covered per frame
const camera = { radius: 600, angleY: 0.0, angleX: 0.6 };          // what is drawn
const target = { angleY: camera.angleY, angleX: camera.angleX };   // where the drag wants it

/* Logical (CSS pixel) size of the canvas; the backing store is scaled by DPR */
const view = { w: canvas.width, h: canvas.height };

/* UI state */
let hueModeState = ui.hueMode.value;          // "degrees" (0-360) or "opencv" (0-179)
const drag = { active: false, pointerId: null, x: 0, y: 0 };
let renderQueued = false;

/* Small vector helpers */
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const normalize = (a) => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/* --------------------------------------------------------------- 2. Camera */

/**
 * Orbit camera. The position is a point on a sphere of radius camera.radius
 * around TARGET, parameterised by azimuth (angleY) and elevation (angleX).
 * The returned basis is a look-at frame: fwd points at the target, right is
 * fwd x worldUp, and up is recomputed as right x fwd so the three are
 * orthonormal. Elevation is clamped elsewhere so fwd never aligns with up.
 */
function getCamera() {
  const { radius, angleX, angleY } = camera;
  const pos = {
    x: TARGET.x + radius * Math.cos(angleX) * Math.sin(angleY),
    y: TARGET.y + radius * Math.sin(angleX),
    z: TARGET.z + radius * Math.cos(angleX) * Math.cos(angleY),
  };
  const fwd = normalize(sub(TARGET, pos));
  const right = normalize(cross(fwd, WORLD_UP));
  const up = cross(right, fwd);
  return { pos, right, up, fwd };
}

/* ----------------------------------------------------------- 3. Projection */

/** World point -> camera-space coordinates (x right, y up, z into the scene). */
function worldToView(cam, p) {
  const d = sub(p, cam.pos);
  return { x: dot(d, cam.right), y: dot(d, cam.up), z: dot(d, cam.fwd) };
}

/**
 * Pinhole perspective projection. The focal length is scaled with the
 * viewport so the cone looks the same at every canvas size. Points on or
 * behind the near plane are flagged visible = false and their screen
 * position is clamped, so callers can cull instead of drawing lines that
 * fly across the screen.
 */
function project(cam, p) {
  const v = worldToView(cam, p);
  const inFront = v.z > NEAR;
  const scale = (FOCAL * view.w / REF_SIZE) / (inFront ? v.z : NEAR);
  return {
    sx: view.w / 2 + v.x * scale,
    sy: view.h / 2 - v.y * scale,
    z: v.z,
    visible: inFront,
  };
}

/* --------------------------------------------------------------- 4. Colour */

/**
 * HSV -> RGB. h in degrees (any value; wrapped to [0, 360)), s and v in
 * 0..255. Returns [r, g, b] in 0..255. h = 360 wraps to 0 (red), s = 0 gives
 * grey, v = 0 gives black.
 */
function hsvToRgb(h, s, v) {
  if (!isFinite(h)) h = 0;
  h = ((h % 360) + 360) % 360;
  s /= 255;
  v /= 255;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r, g, b;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** Raw hue slider value -> degrees. OpenCV stores H as degrees / 2. */
function sliderHueToDegrees(raw) {
  return hueModeState === "opencv" ? raw * 2 : raw;
}

/** Convert a hue value between modes exactly (179 <-> 358, 90 <-> 180, ...). */
function convertHue(value, fromMode, toMode) {
  if (fromMode === toMode) return value;
  return toMode === "opencv" ? Math.min(179, Math.round(value / 2)) : value * 2;
}

function hueMax(mode) {
  return mode === "opencv" ? 179 : 360;
}

/* -------------------------------------------------------------- 5. Drawing */

/** Point on the cone in world space from cylindrical coordinates. */
function conePoint(theta, y, r) {
  return { x: r * Math.cos(theta), y, z: r * Math.sin(theta) };
}

/** Outward normal of the lateral surface at azimuth theta (not normalised). */
function lateralNormal(theta) {
  return { x: HEIGHT * Math.cos(theta), y: -RADIUS, z: HEIGHT * Math.sin(theta) };
}

/** True if a surface with this outward normal at this point faces the camera. */
function facesCamera(normal, point, cam) {
  return dot(normal, sub(cam.pos, point)) > 0;
}

/**
 * The mesh is built once in world space. Each face is a quad (a triangle at
 * the apex ring and the disc centre) with its outward normal, centroid and
 * fill colour precomputed, so a frame only has to cull, project and sort.
 */
function buildMesh() {
  const faces = [];
  const TWO_PI = Math.PI * 2;
  const add = (pts, normal, rgb) => {
    const c = { x: 0, y: 0, z: 0 };
    for (const p of pts) { c.x += p.x / pts.length; c.y += p.y / pts.length; c.z += p.z / pts.length; }
    faces.push({ pts, normal, centroid: c, fill: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` });
  };

  // Lateral surface: rings from the apex (V = 0) up to the disc (V = 255).
  for (let i = 0; i < STEPS_V; i++) {
    const t1 = i / STEPS_V;
    const t2 = (i + 1) / STEPS_V;
    const y1 = t1 * HEIGHT, y2 = t2 * HEIGHT;
    const r1 = t1 * RADIUS, r2 = t2 * RADIUS;
    const vLayer = ((t1 + t2) / 2) * 255;

    for (let j = 0; j < STEPS_H; j++) {
      const a1 = (j / STEPS_H) * TWO_PI;
      const a2 = ((j + 1) / STEPS_H) * TWO_PI;
      const hueDeg = (j / STEPS_H) * 360;
      const P11 = conePoint(a1, y1, r1);
      const P12 = conePoint(a2, y1, r1);
      const P21 = conePoint(a1, y2, r2);
      const P22 = conePoint(a2, y2, r2);
      // At the apex P11 and P12 coincide, so the quad collapses to a triangle.
      add(r1 > 0 ? [P11, P12, P22, P21] : [P11, P22, P21], lateralNormal((a1 + a2) / 2), hsvToRgb(hueDeg, 255, vLayer));
    }
  }

  // Top disc: saturation grows from 0 (white) at the centre to 255 at the rim.
  for (let i = 0; i < STEPS_S; i++) {
    const s1 = i / STEPS_S;
    const s2 = (i + 1) / STEPS_S;
    const r1 = s1 * RADIUS, r2 = s2 * RADIUS;
    const sLayer = ((s1 + s2) / 2) * 255;

    for (let j = 0; j < STEPS_H; j++) {
      const a1 = (j / STEPS_H) * TWO_PI;
      const a2 = ((j + 1) / STEPS_H) * TWO_PI;
      const hueDeg = (j / STEPS_H) * 360;
      const P11 = conePoint(a1, HEIGHT, r1);
      const P12 = conePoint(a2, HEIGHT, r1);
      const P21 = conePoint(a1, HEIGHT, r2);
      const P22 = conePoint(a2, HEIGHT, r2);
      add(r1 > 0 ? [P11, P12, P22, P21] : [P11, P22, P21], DISC_NORMAL, hsvToRgb(hueDeg, sLayer, 255));
    }
  }
  return faces;
}

const MESH = buildMesh();

/**
 * Cull, project and depth-sort the mesh for this camera. Back-face culling
 * uses the analytic normal so the far side is never sorted or drawn; faces
 * that cross the near plane are dropped. Result is in painter's order.
 */
function projectMesh(cam) {
  const out = [];
  for (const f of MESH) {
    if (!facesCamera(f.normal, f.centroid, cam)) continue;
    const pts = new Array(f.pts.length);
    let depth = 0;
    let ok = true;
    for (let k = 0; k < f.pts.length; k++) {
      const p = project(cam, f.pts[k]);
      if (!p.visible) { ok = false; break; }
      pts[k] = p;
      depth += p.z;
    }
    if (ok) out.push({ pts, depth: depth / pts.length, fill: f.fill });
  }
  out.sort((a, b) => b.depth - a.depth);
  return out;
}

/**
 * Fill the sorted faces far to near. The faint edge strokes are the most
 * expensive part of a frame, so they are only drawn once the view has
 * settled (withEdges = false while dragging or easing).
 */
function drawFaces(faces, withEdges) {
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0,0,0,0.08)";
  for (const f of faces) {
    ctx.beginPath();
    ctx.moveTo(f.pts[0].sx, f.pts[0].sy);
    for (let k = 1; k < f.pts.length; k++) ctx.lineTo(f.pts[k].sx, f.pts[k].sy);
    ctx.closePath();
    ctx.fillStyle = f.fill;
    ctx.fill();
    if (withEdges) ctx.stroke();
  }
}

/**
 * Marker for the selected colour. For S < 255 the point lies inside the
 * solid cone, so the marker is always drawn on top of the mesh. To still
 * convey depth it is drawn solid when its part of the surface faces the
 * camera and as a dashed, translucent ring when it is on the far side.
 */
function drawMarker(cam, hueDeg, s, v) {
  const theta = (hueDeg * Math.PI) / 180;
  const y = (v / 255) * HEIGHT;
  const r = (s / 255) * (v / 255) * RADIUS;
  const P = conePoint(theta, y, r);
  const p = project(cam, P);
  if (!p.visible) return;

  const onDisc = v >= 255;
  const onSide = s >= 255;
  const sideFacing = facesCamera(lateralNormal(theta), P, cam);
  const discFacing = facesCamera(DISC_NORMAL, P, cam);
  const inFront = onDisc ? (discFacing || (onSide && sideFacing)) : sideFacing;

  const [cr, cg, cb] = hsvToRgb(hueDeg, s, v);
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.sx, p.sy, 6, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#222";
  if (inFront) {
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
  } else {
    ctx.fillStyle = `rgba(${cr},${cg},${cb},0.4)`;
    ctx.setLineDash([3, 3]);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Arrow head at `tip`, pointing along the direction from `from` to `tip`. */
function drawArrowHead(from, tip, size) {
  const angle = Math.atan2(tip.sy - from.sy, tip.sx - from.sx);
  ctx.beginPath();
  ctx.moveTo(tip.sx, tip.sy);
  ctx.lineTo(tip.sx - size * Math.cos(angle - Math.PI / 6), tip.sy - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(tip.sx - size * Math.cos(angle + Math.PI / 6), tip.sy - size * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

/** Straight arrow between two projected points; skipped if either is behind the camera. */
function drawArrow(p1, p2) {
  if (!p1.visible || !p2.visible) return;
  ctx.beginPath();
  ctx.moveTo(p1.sx, p1.sy);
  ctx.lineTo(p2.sx, p2.sy);
  ctx.stroke();
  drawArrowHead(p1, p2, 10);
}

/** Arc along the rim of the disc from startTheta to endTheta, with an arrow head. */
function drawHueArc(cam, startTheta, endTheta, steps) {
  let prev = null;
  let last = null;
  let started = false;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const theta = startTheta + (i / steps) * (endTheta - startTheta);
    const p = project(cam, conePoint(theta, HEIGHT, RADIUS));
    if (!p.visible) { started = false; continue; }
    if (!started) { ctx.moveTo(p.sx, p.sy); started = true; }
    else ctx.lineTo(p.sx, p.sy);
    prev = last;
    last = p;
  }
  ctx.stroke();
  if (prev && last) drawArrowHead(prev, last, 6);
}

/** Labelled axes: Value (height), Saturation (radius) and Hue (angle). */
function drawGuides(cam) {
  ctx.strokeStyle = "black";
  ctx.fillStyle = "black";
  ctx.lineWidth = 2;
  ctx.font = "14px sans-serif";

  // Value: from the apex up through the disc centre.
  const apex = project(cam, { x: 0, y: 0, z: 0 });
  const valueTip = project(cam, { x: 0, y: HEIGHT * 1.15, z: 0 });
  drawArrow(apex, valueTip);
  if (valueTip.visible) ctx.fillText("Value", valueTip.sx + 6, valueTip.sy);

  // Saturation: from the disc centre out to the rim at hue 0.
  const centre = project(cam, { x: 0, y: HEIGHT, z: 0 });
  const rim = project(cam, { x: RADIUS, y: HEIGHT, z: 0 });
  drawArrow(centre, rim);
  if (rim.visible) ctx.fillText("Saturation", rim.sx + 6, rim.sy);

  // Hue: a quarter arc along the rim in the direction of increasing hue.
  drawHueArc(cam, 0, Math.PI / 2, 48);
  const hueLabel = project(cam, conePoint(Math.PI * 0.6, HEIGHT, RADIUS * 1.05));
  if (hueLabel.visible) ctx.fillText("Hue", hueLabel.sx + 6, hueLabel.sy);
}

/** Full frame: background, cone mesh, selected-colour marker, guides. */
function draw(withEdges = true) {
  ctx.fillStyle = "#ddd";
  ctx.fillRect(0, 0, view.w, view.h);

  const cam = getCamera();
  drawFaces(projectMesh(cam), withEdges);

  const { hDeg, s, v } = readSliders();
  drawMarker(cam, hDeg, s, v);
  drawGuides(cam);
}

/**
 * One animation frame. The drawn camera eases toward the drag target, which
 * turns jittery pointer deltas into smooth motion, and frames keep coming
 * only while there is distance left to cover. Edge strokes are skipped
 * while moving; a final full-quality frame is drawn once the view settles.
 */
function frame() {
  renderQueued = false;
  const dY = target.angleY - camera.angleY;
  const dX = target.angleX - camera.angleX;
  const moving = Math.abs(dY) > 1e-4 || Math.abs(dX) > 1e-4;
  if (moving) {
    camera.angleY += dY * SMOOTHING;
    camera.angleX += dX * SMOOTHING;
  } else {
    camera.angleY = target.angleY;
    camera.angleX = target.angleX;
  }
  draw(!moving && !drag.active);
  if (moving) requestRender();
}

/** Coalesce redraw requests into one animation frame. */
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(frame);
}

/* --------------------------------------------------------------- 6. Events */

function readSliders() {
  const hRaw = parseInt(ui.hue.value, 10) || 0;
  const s = parseInt(ui.sat.value, 10) || 0;
  const v = parseInt(ui.val.value, 10) || 0;
  return { hRaw, hDeg: sliderHueToDegrees(hRaw), s, v };
}

/** Sync number boxes and the colour preview with the sliders, then redraw. */
function updateDisplayAndDraw() {
  const { hRaw, hDeg, s, v } = readSliders();
  ui.hueVal.value = hRaw;
  ui.satVal.value = s;
  ui.valVal.value = v;

  const [r, g, b] = hsvToRgb(hDeg, s, v);
  ui.colorBox.style.backgroundColor = `rgb(${r},${g},${b})`;
  ui.hexDisplay.textContent = rgbToHex(r, g, b);

  requestRender();
}

/** Switch between degrees (0-360) and OpenCV (0-179) hue ranges. */
function setHueMode(mode) {
  const converted = convertHue(parseInt(ui.hue.value, 10) || 0, hueModeState, mode);
  hueModeState = mode;
  ui.hue.max = hueMax(mode);
  ui.hueVal.max = hueMax(mode);
  ui.hue.value = converted;
  ui.hueVal.value = converted;
  ui.hueUnit.textContent = mode === "degrees" ? "°" : "";
  updateDisplayAndDraw();
}

/** Keep a range slider and its number box in sync; clamp typed values. */
function bindPair(range, number) {
  range.addEventListener("input", updateDisplayAndDraw);
  number.addEventListener("input", () => {
    let n = parseInt(number.value, 10);
    if (isNaN(n)) n = 0;
    n = clamp(n, parseInt(number.min, 10), parseInt(number.max, 10));
    range.value = n;
    number.value = n;
    updateDisplayAndDraw();
  });
}

/* Orbit controls. Pointer events cover mouse, touch and pen; pointer capture
 * keeps delivering move/up events to the canvas while the pointer is outside
 * it, so a drag released off-canvas still ends cleanly. */
function onPointerDown(e) {
  if (drag.active) return;                    // ignore extra fingers
  drag.active = true;
  drag.pointerId = e.pointerId;
  drag.x = e.clientX;
  drag.y = e.clientY;
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* unsupported or synthetic event */ }
  e.preventDefault();
}

function onPointerMove(e) {
  if (!drag.active || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
  // "Grab" semantics: the surface under the pointer follows it. Dragging
  // right spins the cone to the right (the camera orbits the other way);
  // dragging down tips the near side down (the camera rises).
  const speed = ORBIT_SPEED * (REF_SIZE / view.w);
  target.angleY -= dx * speed;
  target.angleX = clamp(target.angleX + dy * speed, -MAX_ELEVATION, MAX_ELEVATION);
  requestRender();
}

function endDrag(e) {
  if (e && e.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
  if (!drag.active) return;
  drag.active = false;
  drag.pointerId = null;
  // Keep the azimuth bounded without disturbing the easing offset.
  const turns = Math.round(target.angleY / (Math.PI * 2)) * Math.PI * 2;
  target.angleY -= turns;
  camera.angleY -= turns;
  requestRender();                            // final full-quality frame
}

/* Match the backing store to the CSS size times devicePixelRatio so the
 * canvas stays sharp on HiDPI screens and at every responsive breakpoint. */
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  view.w = Math.round(rect.width) || canvas.width;
  view.h = Math.round(rect.height) || canvas.height;
  const bw = Math.round(view.w * dpr);
  const bh = Math.round(view.h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);     // draw in CSS pixels
}

function onResize() {
  resizeCanvas();
  requestRender();
}

/* ----------------------------------------------------------------- 7. Init */

(function init() {
  bindPair(ui.hue, ui.hueVal);
  bindPair(ui.sat, ui.satVal);
  bindPair(ui.val, ui.valVal);
  ui.hueMode.addEventListener("change", (e) => setHueMode(e.target.value));

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  window.addEventListener("pointerup", endDrag);   // fallback without pointer capture
  window.addEventListener("blur", () => endDrag());

  if (window.ResizeObserver) {
    new ResizeObserver(onResize).observe(canvas);
  }
  window.addEventListener("resize", onResize);

  resizeCanvas();
  setHueMode(hueModeState);
})();

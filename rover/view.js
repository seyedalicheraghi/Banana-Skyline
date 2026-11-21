// Geometry for seeing exactly what the rover's camera sees. No DOM or three.js: tested in Node.
//
// Every pixel of the camera picture was seen from one direction. Showing the picture so that each pixel
// sits in that same direction from your eyes gives the view through the camera at its true size. For the
// EarthRover's wide-angle (fisheye) lens that surface is a piece of sphere around you (domeMesh). For a
// rectilinear lens it would be a flat picture at distance d, 2·d·tan(H/2) wide (pictureSize; the desktop
// view uses that, since a flat screen shows the picture as it is). The picture can be shown smaller
// ('framed') for comfort, so its edges stay in sight as a fixed frame while the rover moves.

export const DEG = Math.PI / 180;

/**
 * Horizontal field of view of each camera (degrees) and its lens. Both Mini+ cameras are GC2093 modules
 * (1920x1080) that the SDK documents as 148° diagonal, 126° horizontal, 67° vertical, streamed scaled (not
 * cropped) to 1024x576 (front) and 480x270 (rear), mounted level about 15 cm up. A rectilinear lens with
 * 126° across would be 96° tall; an equisolid-angle fisheye (r = 2f·sin(θ/2)) with 126° across gives
 * 68.4° tall and 147.3° diagonal, matching the published set. Adjust with ?fov= / ?rearfov= / ?lens=.
 */
export const CAMERAS = {
  front: { hfov: 126, lens: 'fisheye' },
  rear: { hfov: 126, lens: 'fisheye' },
};

/** The lens model to use: the camera's, or ?lens=rectilinear|fisheye. */
export function cameraLens(view, params) {
  const lens = params?.get?.('lens');
  return lens === 'rectilinear' || lens === 'fisheye' ? lens : CAMERAS[view].lens;
}

/**
 * Direction (unit vector; the camera looks down -Z, +Y up) from which image point (u, v) was seen, for an
 * equisolid-angle fisheye (r = 2f·sin(θ/2)) whose horizontal field of view `hfovDeg` spans the image width.
 * u and v run 0..1, v down from the top row; `aspect` is width / height.
 */
export function fisheyeDirection(u, v, hfovDeg, aspect) {
  const f = 0.5 / (2 * Math.sin(Math.min(hfovDeg, 359) * DEG / 4)); // focal length in image widths
  const dx = u - 0.5;
  const dy = (0.5 - v) / aspect; // in image widths, up positive
  const theta = 2 * Math.asin(Math.min(1, Math.hypot(dx, dy) / (2 * f)));
  const phi = Math.atan2(dy, dx);
  const s = Math.sin(theta);
  return { x: s * Math.cos(phi), y: s * Math.sin(phi), z: -Math.cos(theta) };
}

/**
 * The picture as a grid on a sphere of `radius` around the eye, each vertex in the direction its pixel was
 * seen from. UVs read a top-row-first bitmap (flipY off). Triangles face the centre.
 * @returns {{positions: Float32Array, uvs: Float32Array, indices: Uint16Array}}
 */
export function domeMesh(hfovDeg, aspect, radius = PICTURE_DISTANCE, cols = 48, rows = 27) {
  const positions = new Float32Array((cols + 1) * (rows + 1) * 3);
  const uvs = new Float32Array((cols + 1) * (rows + 1) * 2);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const k = j * (cols + 1) + i;
      const u = i / cols;
      const v = j / rows;
      const d = fisheyeDirection(u, v, hfovDeg, aspect);
      positions.set([d.x * radius, d.y * radius, d.z * radius], k * 3);
      uvs.set([u, v], k * 2);
    }
  }
  const indices = new Uint16Array(cols * rows * 6);
  let n = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const tl = j * (cols + 1) + i;
      const bl = tl + cols + 1;
      indices.set([tl, bl, tl + 1, bl, bl + 1, tl + 1], n);
      n += 6;
    }
  }
  return { positions, uvs, indices };
}

/** How far below the eye (metres, positive) the bottom middle of a dome picture reaches. */
export function domeDrop(hfovDeg, aspect, radius = PICTURE_DISTANCE) {
  return -fisheyeDirection(0.5, 1, hfovDeg, aspect).y * radius;
}

export const VIEW_MODES = {
  exact: { scale: 1, label: 'Exact camera view' },
  framed: { scale: 0.7, label: 'Framed view' },
};

export const PICTURE_DISTANCE = 4; // metres: far enough to read as a view, near enough to stay sharp in stereo
export const MAX_HFOV = 170; // tan() runs away near 180°

/** Field of view to use for a camera: the default, or a sane override from the URL. */
export function cameraFov(view, params) {
  const raw = params?.get?.(view === 'rear' ? 'rearfov' : 'fov');
  const v = Number(raw);
  return raw !== null && raw !== undefined && Number.isFinite(v) && v >= 20 && v <= MAX_HFOV ? v : CAMERAS[view].hfov;
}

/** Size of a flat picture at `distance` that spans `hfovDeg` horizontally, for a picture of `aspect` (w/h). */
export function pictureSize(hfovDeg, aspect, distance = PICTURE_DISTANCE) {
  const h = Math.min(Math.max(hfovDeg, 1), MAX_HFOV) * DEG;
  const width = 2 * distance * Math.tan(h / 2);
  return { width, height: width / aspect };
}

/** Vertical field of view (degrees) of a rectilinear picture with horizontal FOV `hfovDeg` and `aspect`. */
export function verticalFov(hfovDeg, aspect) {
  return 2 * Math.atan(Math.tan(Math.min(hfovDeg, MAX_HFOV) * DEG / 2) / aspect) / DEG;
}

/**
 * Vertical FOV (degrees) for a desktop camera at the picture's viewpoint so the whole picture fits a
 * window of `windowAspect` (w/h): it fills the window's height or width, whichever runs out first.
 */
export function desktopFov(hfovDeg, aspect, windowAspect) {
  const halfH = Math.tan(Math.min(hfovDeg, MAX_HFOV) * DEG / 2);
  const halfV = halfH / aspect;
  const half = Math.max(halfV, halfH / windowAspect);
  return 2 * Math.atan(half) / DEG;
}

/**
 * Heading (radians about +Y; 0 looks down -Z) of a forward direction, ignoring pitch and roll.
 * Returns `fallback` when looking almost straight up or down, where the heading is undefined.
 */
export function yawOf(fx, fz, fallback = 0) {
  if (Math.hypot(fx, fz) < 1e-3) return fallback;
  return Math.atan2(-fx, -fz);
}

/** Forward direction (x, z) of quaternion (x, y, z, w) applied to (0, 0, -1). */
export function forwardOf(qx, qy, qz, qw) {
  // Third column of the rotation matrix, negated.
  return { x: -2 * (qx * qz + qw * qy), y: -2 * (qy * qz - qw * qx), z: -(1 - 2 * (qx * qx + qy * qy)) };
}

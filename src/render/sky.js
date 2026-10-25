// Sky: gradient dome and stars (in the scene, following the camera), the sun/moon with a face and drifting clouds (in the world).
import * as THREE from 'three';
import { SUN } from '../core/constants.js';
import { createRng } from '../core/rng.js';
import { clamp, glowTexture, themeColor } from './util.js';

const DOME_RADIUS = 1200;  // scene units at world scale 1
const STAR_RADIUS = 1100;
const ORB_PAD = 1.75;      // sprite size / disc diameter: room for glow and rays
const ORB_Z = -8;
const SHOCK_SECONDS = 2;

const DOME_VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const DOME_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uFog;
uniform vec3 uGlow;
uniform vec3 uSunPos;
uniform float uGlowStrength;
varying vec3 vWorldPos;
void main() {
  vec3 dir = normalize(vWorldPos - cameraPosition);
  float h = dir.y;
  vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.3, h));
  col = mix(col, uZenith, smoothstep(0.3, 0.9, h));
  col = mix(uFog, col, smoothstep(-0.03, 0.06, h));
  float g = max(dot(dir, normalize(uSunPos - cameraPosition)), 0.0);
  col += uGlow * uGlowStrength * (0.7 * pow(g, 24.0) + 0.3 * pow(g, 4.0));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Dither after encoding so long dark gradients do not band.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor.rgb += (n - 0.5) / 255.0;
}`;

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uPixelRatio;
varying float vBright;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.7 + 0.3 * sin(uTime * (1.1 + aPhase * 1.7) + aPhase * 40.0);
  vBright = tw * smoothstep(0.02, 0.22, normalize(position).y);
  gl_PointSize = aSize * uPixelRatio * (0.85 + 0.15 * tw);
}`;

const STAR_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vBright;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.05, d) * vBright;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

// Moon craters, in disc-radius units (kept away from the eyes and mouth).
const CRATERS = [[-0.58, -0.5, 0.13], [0.52, -0.58, 0.09], [0.66, 0.3, 0.12], [-0.66, 0.42, 0.08], [0.12, -0.8, 0.07], [-0.2, 0.78, 0.06]];

function drawOrb(ctx, size, orb, expr) {
  const c = size / 2;
  const R = size / (2 * ORB_PAD);
  ctx.clearRect(0, 0, size, size);

  if (orb.glow) {
    const [r, g, b] = orb.glow;
    const grad = ctx.createRadialGradient(c, c, R * 0.85, c, c, size / 2);
    grad.addColorStop(0, `rgba(${r},${g},${b},${orb.glowAlpha})`);
    grad.addColorStop(0.35, `rgba(${r},${g},${b},${orb.glowAlpha * 0.35})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  if (orb.rays) {
    ctx.strokeStyle = orb.rays;
    ctx.lineCap = 'round';
    ctx.lineWidth = R * 0.1;
    const n = 16;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r0 = R * 1.14;
      const r1 = R * (i % 2 ? 1.4 : 1.66);
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
      ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
      ctx.stroke();
    }
  }

  const body = ctx.createRadialGradient(c - R * 0.3, c - R * 0.35, R * 0.1, c, c, R);
  body.addColorStop(0, orb.rim);
  body.addColorStop(0.55, orb.fill);
  body.addColorStop(1, orb.edge);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(c, c, R, 0, Math.PI * 2);
  ctx.fill();

  if (orb.craters) {
    ctx.fillStyle = orb.craters;
    for (const [dx, dy, r] of CRATERS) {
      ctx.beginPath();
      ctx.arc(c + dx * R, c + dy * R, r * R, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (orb.cheek && expr !== 'shocked') {
    ctx.fillStyle = orb.cheek;
    ctx.globalAlpha = 0.45;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(c + s * 0.52 * R, c + 0.2 * R, 0.14 * R, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = orb.face;
  ctx.strokeStyle = orb.face;
  ctx.lineCap = 'round';
  for (const s of [-1, 1]) {
    const ex = c + s * 0.32 * R;
    const ey = c - 0.14 * R;
    if (expr === 'shocked') {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex, ey, 0.17 * R, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 0.045 * R;
      ctx.stroke();
      ctx.fillStyle = orb.face;
      ctx.beginPath();
      ctx.arc(ex, ey, 0.06 * R, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 0.05 * R;
      ctx.beginPath();
      ctx.arc(ex, ey - 0.12 * R, 0.17 * R, 1.2 * Math.PI, 1.8 * Math.PI);
      ctx.stroke();
    } else if (expr === 'blink') {
      ctx.lineWidth = 0.06 * R;
      ctx.beginPath();
      ctx.arc(ex, ey - 0.04 * R, 0.1 * R, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.ellipse(ex, ey, 0.085 * R, 0.13 * R, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(ex - 0.025 * R, ey - 0.05 * R, 0.03 * R, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = orb.face;
    }
  }
  if (expr === 'shocked') {
    ctx.beginPath();
    ctx.ellipse(c, c + 0.42 * R, 0.15 * R, 0.2 * R, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.lineWidth = 0.075 * R;
    ctx.beginPath();
    ctx.arc(c, c + 0.04 * R, 0.42 * R, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();
  }
}

function makeOrbTextures(orb, size) {
  if (typeof document === 'undefined') return null;
  const out = {};
  for (const expr of ['normal', 'blink', 'shocked']) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    drawOrb(ctx, size, orb, expr);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    out[expr] = tex;
  }
  return out;
}

export class Sky {
  /**
   * @param {{scene: THREE.Scene, world: THREE.Object3D, quality: 'high'|'quest', renderer?: THREE.WebGLRenderer}} opts
   */
  constructor({ scene, world, quality, renderer }) {
    this.scene = scene;
    this.quality = quality;
    this.renderer = renderer;
    this.cameraPos = new THREE.Vector3(72, 40, 160); // updated from the last rendered camera
    this.sunPos = new THREE.Vector3();
    this.shockTime = 0;
    this.blinkTimer = 3;
    this.blinkLeft = 0;
    this.textures = null;
    this.currentExpr = '';

    this.domeMat = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uMid: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uFog: { value: new THREE.Color() },
        uGlow: { value: new THREE.Color() },
        uSunPos: { value: new THREE.Vector3() },
        uGlowStrength: { value: 0 },
      },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), this.domeMat);
    this.dome.name = 'skyDome';
    this.dome.renderOrder = -1000;
    this.dome.frustumCulled = false;
    this.dome.onBeforeRender = (_r, _s, camera) => this.cameraPos.setFromMatrixPosition(camera.matrixWorld);
    scene.add(this.dome);

    this.stars = this.makeStars(quality === 'quest' ? 520 : 950);
    scene.add(this.stars);

    this.orbMat = new THREE.SpriteMaterial({ transparent: true, fog: false, depthWrite: false });
    this.orb = new THREE.Sprite(this.orbMat);
    this.orb.name = 'sunMoon';
    this.orb.position.set(SUN.x, SUN.y, ORB_Z);
    this.orbSize = SUN.radius * 2 * ORB_PAD;
    this.orb.scale.set(this.orbSize, this.orbSize, 1);
    world.add(this.orb);

    this.makeClouds(world, quality === 'quest' ? 7 : 11);
  }

  makeStars(count) {
    const rng = createRng(1234567);
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Most stars sit behind the city as seen from the PC camera (toward -z), low in the sky.
      const behind = rng.next() < 0.7;
      const az = behind ? -Math.PI / 2 + (rng.next() - 0.5) * 2.6 : rng.next() * Math.PI * 2;
      const y = behind ? 0.03 + Math.pow(rng.next(), 1.4) * 0.6 : 0.03 + rng.next() * 0.97;
      const r = Math.sqrt(1 - y * y);
      pos[i * 3] = Math.cos(az) * r;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(az) * r;
      size[i] = 1.1 + Math.pow(rng.next(), 3) * 2.6;
      phase[i] = rng.next();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
        uColor: { value: new THREE.Color('#fff8e8') },
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const points = new THREE.Points(geo, this.starMat);
    points.name = 'stars';
    points.frustumCulled = false;
    points.renderOrder = -900;
    return points;
  }

  makeClouds(world, count) {
    const rng = createRng(424242);
    this.clouds = [];
    let puffs = 0;
    for (let i = 0; i < count; i++) {
      const n = 5 + rng.int(0, 2);
      const cloud = {
        x: -420 + (i / count) * 1000 + rng.float(-40, 40),
        y: rng.float(115, 180),
        z: rng.float(-420, -220),
        puffs: [],
      };
      const w = rng.float(26, 48);
      for (let j = 0; j < n; j++) {
        const t = n > 1 ? j / (n - 1) : 0.5;
        const r = rng.float(7, 12) * (1 - Math.abs(t - 0.5) * 0.8);
        cloud.puffs.push({ ox: (t - 0.5) * w + rng.float(-3, 3), oy: rng.float(-1, 4) * (1 - Math.abs(t - 0.5)), oz: rng.float(-5, 5), r, shade: rng.float(0.88, 1.04) });
      }
      puffs += n;
      this.clouds.push(cloud);
    }
    this.cloudMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshLambertMaterial(), puffs);
    this.cloudMesh.name = 'clouds';
    this.cloudMesh.frustumCulled = false;
    this.cloudMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(puffs * 3), 3);
    world.add(this.cloudMesh);
    this.tmpMatrix = new THREE.Matrix4();
    this.tmpPos = new THREE.Vector3();
    this.tmpScale = new THREE.Vector3();
    this.tmpQuat = new THREE.Quaternion();
    this.layoutClouds();
  }

  layoutClouds() {
    let k = 0;
    for (let i = 0; i < this.clouds.length; i++) {
      const c = this.clouds[i];
      for (let j = 0; j < c.puffs.length; j++) {
        const p = c.puffs[j];
        this.tmpPos.set(c.x + p.ox, c.y + p.oy, c.z + p.oz);
        this.tmpScale.set(p.r * 1.45, p.r * 0.72, p.r);
        this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
        this.cloudMesh.setMatrixAt(k++, this.tmpMatrix);
      }
    }
    this.cloudMesh.instanceMatrix.needsUpdate = true;
  }

  /** @param {import('./themes.js').Theme} theme */
  setTheme(theme) {
    const u = this.domeMat.uniforms;
    u.uZenith.value.copy(themeColor(theme.sky.zenith));
    u.uMid.value.copy(themeColor(theme.sky.mid));
    u.uHorizon.value.copy(themeColor(theme.sky.horizon));
    u.uFog.value.copy(themeColor(theme.fog));
    u.uGlow.value.copy(themeColor(theme.sky.glow));
    u.uGlowStrength.value = theme.sky.glowStrength;
    this.stars.visible = Boolean(theme.stars);

    const old = this.textures;
    this.textures = makeOrbTextures(theme.orb, this.quality === 'quest' ? 256 : 512);
    if (this.textures) {
      this.orbMat.map = this.textures.normal;
      this.orbMat.color.set(0xffffff);
    } else {
      this.orbMat.map = glowTexture();
      this.orbMat.color.copy(themeColor(theme.orb.fill));
    }
    this.orbMat.needsUpdate = true;
    this.currentExpr = 'normal';
    if (old) for (const t of Object.values(old)) t.dispose();

    this.cloudMesh.visible = Boolean(theme.clouds);
    if (theme.clouds) {
      const base = themeColor(theme.clouds);
      const c = new THREE.Color();
      let k = 0;
      for (const cloud of this.clouds) {
        for (const p of cloud.puffs) this.cloudMesh.setColorAt(k++, c.copy(base).multiplyScalar(p.shade));
      }
      this.cloudMesh.instanceColor.needsUpdate = true;
    }
  }

  /** The banana flew through the sun: shocked face for a while. */
  shock(seconds = SHOCK_SECONDS) {
    this.shockTime = Math.max(this.shockTime, seconds);
  }

  /**
   * @param {number} dt
   * @param {number} time seconds since start
   * @param {number} wind game wind (-15..15)
   * @param {number} scale world scale (1 on PC, VR_SCALE in VR)
   */
  update(dt, time, wind, scale) {
    this.dome.position.copy(this.cameraPos);
    this.dome.scale.setScalar(DOME_RADIUS * scale);
    this.stars.position.copy(this.cameraPos);
    this.stars.scale.setScalar(STAR_RADIUS * scale);
    this.starMat.uniforms.uTime.value = time;
    this.starMat.uniforms.uPixelRatio.value = this.renderer?.getPixelRatio?.() ?? 1;
    this.orb.getWorldPosition(this.sunPos);
    this.domeMat.uniforms.uSunPos.value.copy(this.sunPos);

    // Face: shocked > blinking > normal.
    this.shockTime = Math.max(0, this.shockTime - dt);
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkLeft = 0.16;
      this.blinkTimer = 2.5 + Math.random() * 4.5;
    }
    this.blinkLeft = Math.max(0, this.blinkLeft - dt);
    const expr = this.shockTime > 0 ? 'shocked' : this.blinkLeft > 0 ? 'blink' : 'normal';
    if (this.textures && expr !== this.currentExpr) {
      this.orbMat.map = this.textures[expr];
      this.currentExpr = expr;
    }
    const shock = clamp(this.shockTime / 0.4, 0, 1);
    this.orbMat.rotation = 0.04 * Math.sin(time * 0.6) + shock * 0.07 * Math.sin(time * 34);
    const s = this.orbSize * (1 + 0.012 * Math.sin(time * 1.3) + 0.12 * shock);
    this.orb.scale.set(s, s, 1);

    if (this.cloudMesh.visible) {
      const v = 0.9 + wind * 0.12;
      for (let i = 0; i < this.clouds.length; i++) {
        const c = this.clouds[i];
        c.x += v * dt;
        if (c.x > 640) c.x -= 1100;
        else if (c.x < -460) c.x += 1100;
      }
      this.layoutClouds();
    }
  }

  dispose() {
    this.dome.removeFromParent();
    this.stars.removeFromParent();
    this.orb.removeFromParent();
    this.cloudMesh.removeFromParent();
    this.dome.geometry.dispose();
    this.domeMat.dispose();
    this.stars.geometry.dispose();
    this.starMat.dispose();
    if (this.textures) for (const t of Object.values(this.textures)) t.dispose();
    this.orbMat.dispose();
    this.cloudMesh.geometry.dispose();
    this.cloudMesh.material.dispose();
    this.cloudMesh.dispose();
  }
}

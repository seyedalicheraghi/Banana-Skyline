// Rover Cockpit: the video stream parser, the stick-to-command mapping and the rules for sending commands.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MjpegParser } from '../rover/mjpeg.js';
import { CommandLink, DEADZONE, Edges, MIN_DRIVE, STALE_MS, STOP_REPEATS, StickClicks, commandFrom, readPad, shape } from '../rover/drive.js';

const enc = s => new TextEncoder().encode(s);
function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) { out.set(a, at); at += a.length; }
  return out;
}
const part = (data, type = 'image/jpeg') => concat(enc(`--frame\r\nContent-Type: ${type}\r\nContent-Length: ${data.length}\r\n\r\n`), data, enc('\r\n'));

describe('MjpegParser', () => {
  // Image bytes that contain the separators the parser looks for.
  const a = concat(Uint8Array.of(0xff, 0xd8, 1, 2, 3), enc('\r\n\r\n--frame\r\n'), Uint8Array.of(0xff, 0xd9));
  const b = Uint8Array.of(9, 8, 7);
  const stream = concat(part(a), part(b, 'image/png'), part(a));

  test('returns every image whole, with its type', () => {
    const parts = new MjpegParser().push(stream);
    assert.deepEqual(parts.map(p => p.type), ['image/jpeg', 'image/png', 'image/jpeg']);
    assert.deepEqual([...parts[0].data], [...a]);
    assert.deepEqual([...parts[1].data], [...b]);
  });

  test('gives the same images however the bytes are split', () => {
    for (const size of [1, 2, 7, 50]) {
      const parser = new MjpegParser();
      const parts = [];
      for (let i = 0; i < stream.length; i += size) parts.push(...parser.push(stream.subarray(i, i + size)));
      assert.equal(parts.length, 3, `chunks of ${size}`);
      assert.deepEqual([...parts[2].data], [...a]);
    }
  });

  test('without Content-Length an image ends at the next boundary', () => {
    const s = enc('--frame\r\nContent-Type: image/jpeg\r\n\r\nABC\r\n--frame\r\nContent-Type: image/jpeg\r\n\r\nDE\r\n--frame\r\n');
    const parts = new MjpegParser().push(s);
    assert.deepEqual(parts.map(p => new TextDecoder().decode(p.data)), ['ABC', 'DE']);
  });
});

describe('commands from the sticks', () => {
  test('a resting stick does nothing', () => {
    assert.equal(shape(DEADZONE * 0.9), 0);
    assert.deepEqual(commandFrom({ throttleY: 0.05, steerX: -0.1 }), { linear: 0, angular: 0, lamp: 0 });
  });

  test('stick up is forward, stick right turns right (negative angular)', () => {
    assert.deepEqual(commandFrom({ throttleY: -1 }), { linear: 1, angular: 0, lamp: 0 });
    assert.deepEqual(commandFrom({ throttleY: 1 }), { linear: -1, angular: 0, lamp: 0 });
    assert.deepEqual(commandFrom({ steerX: 1 }), { linear: 0, angular: -1, lamp: 0 });
    assert.deepEqual(commandFrom({ steerX: -1 }), { linear: 0, angular: 1, lamp: 0 });
  });

  test('reversed steering flips only the turn', () => {
    assert.deepEqual(commandFrom({ throttleY: -1, steerX: 1, steer: -1 }), { linear: 1, angular: 1, lamp: 0 });
    assert.deepEqual(commandFrom({ steerX: -1, steer: -1 }), { linear: 0, angular: -1, lamp: 0 });
  });

  test('stick clicks: each alone on release, both together as one click', () => {
    const clicks = new StickClicks();
    let t = 0;
    // Frames 50 ms apart: [left down, right down].
    const run = frames => frames.map(([l, r]) => clicks.update(!!l, !!r, (t += 50))).filter(Boolean);
    assert.deepEqual(run([[1, 0], [1, 0], [0, 0]]), ['left']);
    assert.deepEqual(run([[0, 1], [0, 0]]), ['right']);
    assert.deepEqual(run([[1, 0], [1, 1], [0, 1], [0, 0]]), ['both']);
    assert.deepEqual(run([[0, 1], [1, 1], [1, 0], [0, 0], [1, 0], [0, 0]]), ['both', 'left']);
    assert.deepEqual(run([[0, 0], [0, 0]]), []);
  });

  test('a stick pressed in while driving is not a click, and does not turn another click into "both"', () => {
    const clicks = new StickClicks();
    let t = 0;
    const run = frames => frames.map(([l, r]) => clicks.update(!!l, !!r, (t += 50))).filter(Boolean);
    // Left stick held in for a second and a half (pushed hard while driving), right stick clicked meanwhile.
    const held = Array.from({ length: 30 }, (_, i) => [1, i >= 10 && i < 13 ? 1 : 0]);
    assert.deepEqual(run([...held, [0, 0]]), ['right']);
    // Held alone for long: nothing.
    assert.deepEqual(run([...Array.from({ length: 20 }, () => [1, 0]), [0, 0]]), []);
    // Both clicked, but 450 ms apart (left pressed first, both released together): ambiguous, so neither.
    assert.deepEqual(run([...Array.from({ length: 9 }, () => [1, 0]), [1, 1], [1, 1], [0, 0]]), []);
  });

  test('the first bit of stick past the dead zone already moves the rover (its deadband is 0.05)', () => {
    const justPast = DEADZONE + 0.01;
    const c = commandFrom({ throttleY: -justPast, steerX: justPast, scale: 0.3 });
    assert.equal(c.linear, MIN_DRIVE);
    assert.equal(c.angular, -MIN_DRIVE);
    assert.ok(MIN_DRIVE > 0.05);
    // Full deflection is still exactly the speed limit, and in between it only grows.
    let prev = 0;
    for (let x = 0.2; x <= 1.0001; x += 0.05) {
      const v = commandFrom({ throttleY: -x, scale: 0.6 }).linear;
      assert.ok(v >= prev, `monotonic at ${x}`);
      prev = v;
    }
    assert.equal(prev, 0.6);
  });

  test('the speed limit scales both, and stop wins over everything', () => {
    assert.deepEqual(commandFrom({ throttleY: -1, steerX: -1, scale: 0.3, lamp: true }), { linear: 0.3, angular: 0.3, lamp: 1 });
    assert.deepEqual(commandFrom({ throttleY: -1, steerX: 1, stop: true, lamp: true }), { linear: 0, angular: 0, lamp: 1 });
  });

  test('never exceeds the range, even for out-of-range axes', () => {
    assert.deepEqual(commandFrom({ throttleY: -3, steerX: 5 }), { linear: 1, angular: -1, lamp: 0 });
  });

  test('readPad takes the thumbstick from axes 2 and 3 of a Touch controller', () => {
    const buttons = [{ pressed: true }, { pressed: false }, {}, { pressed: true }, { pressed: true }, { pressed: false }];
    assert.deepEqual(readPad({ axes: [0, 0, 0.5, -0.75], buttons }), { x: 0.5, y: -0.75, trigger: true, grip: false, stick: true, lower: true, upper: false });
    assert.deepEqual(readPad(null), { x: 0, y: 0, trigger: false, grip: false, stick: false, lower: false, upper: false });
  });

  test('Edges fires once per press', () => {
    const edges = new Edges();
    let n = 0;
    for (const down of [true, true, false, true]) edges.press('a', down, () => n++);
    assert.equal(n, 2);
  });
});

describe('CommandLink', () => {
  function setup() {
    const sent = [];
    let t = 0;
    const link = new CommandLink({ send: async (c) => { sent.push(c); }, now: () => t, staleMs: 300, repeats: 3, settleMs: 1500 });
    const step = async (ms = 100) => { t += ms; link.tick(); await new Promise(r => setImmediate(r)); };
    return { sent, link, step, at: () => t };
  }
  const go = { linear: 0.5, angular: 0, lamp: 0 };
  const zero = { linear: 0, angular: 0, lamp: 0 };

  test('standing still it sends nothing', async () => {
    const { sent, link, step } = setup();
    for (let i = 0; i < 30; i++) { link.setInput(zero); await step(); }
    assert.deepEqual(sent, []);
  });

  test('streams while moving, repeats the stop, then restates the lamp once after the SDK watchdog had its say', async () => {
    const { sent, link, step } = setup();
    for (let i = 0; i < 4; i++) { link.setInput(go); await step(); }
    assert.equal(sent.length, 4);
    for (let i = 0; i < 3; i++) { link.setInput(zero); await step(); }
    assert.deepEqual(sent.slice(4), [zero, zero, zero], 'three repeats');
    for (let i = 0; i < 14; i++) { link.setInput({ ...zero, lamp: 0 }); await step(); }
    assert.equal(sent.length, 7, 'quiet for 1.4 s');
    await step(); // 1.5 s after the last stop
    assert.equal(sent.length, 8, 'one restatement');
    for (let i = 0; i < 30; i++) { link.setInput(zero); await step(); }
    assert.equal(sent.length, 8, 'then quiet');
  });

  test('a lamp switch while parked waits for no restatement unless the rover was driven', async () => {
    const { sent, link, step } = setup();
    link.setInput({ ...zero, lamp: 1 });
    await step();
    for (let i = 0; i < 30; i++) { link.setInput({ ...zero, lamp: 1 }); await step(); }
    assert.deepEqual(sent, [{ ...zero, lamp: 1 }]);
  });

  test('the cockpit uses a 300 ms input limit and five stop repeats', async () => {
    assert.equal(STALE_MS, 300);
    assert.equal(STOP_REPEATS, 5);
    const sent = [];
    let t = 0;
    const link = new CommandLink({ send: async (c) => { sent.push(c); }, now: () => t });
    link.setInput(go);
    link.tick();
    t = 301; // no new input since
    for (let i = 0; i < 8; i++) { link.tick(); await new Promise(r => setImmediate(r)); }
    assert.deepEqual(sent, [go, zero, zero, zero, zero, zero], 'five stops from the first stale tick on, then quiet');
  });

  test('a request that never answers is given up, so the stop behind it still goes out', async () => {
    const sent = [];
    let first = true;
    const link = new CommandLink({
      send: (c) => { sent.push(c); if (first) { first = false; return new Promise(() => {}); } return Promise.resolve(true); },
      now: () => 0,
      timeoutMs: 30,
    });
    link.setInput(go);
    link.tick(); // hangs
    link.halt(); // waits behind it
    await new Promise(r => setTimeout(r, 15));
    assert.deepEqual(sent, [go], 'still waiting');
    await new Promise(r => setTimeout(r, 40));
    assert.deepEqual(sent, [go, zero], 'the stop went out after the timeout');
    assert.equal(link.ok, true);
  });

  test('input that stops arriving becomes a stop', async () => {
    const { sent, link, step } = setup();
    link.setInput(go);
    await step(); // fresh: moving
    await step(); // 200 ms old: still moving
    await step(); // 300 ms: still within the limit
    await step(); // stale
    assert.deepEqual(sent.at(-1), zero);
    assert.deepEqual(sent[0], go);
  });

  test('halt() stops at once even with fresh moving input', async () => {
    const { sent, link } = setup();
    link.setInput(go);
    link.halt();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(sent, [zero]);
  });

  test('a lamp change goes out at once, even standing still', async () => {
    const { sent, link, step } = setup();
    link.setInput({ ...zero, lamp: 1 });
    await step();
    link.setInput({ ...zero, lamp: 1 });
    await step();
    assert.deepEqual(sent, [{ ...zero, lamp: 1 }]);
  });

  test('after halt() the rover stays stopped until fresh input arrives', async () => {
    const { sent, link, step } = setup();
    link.setInput(go);
    await step();
    link.halt();
    await step(); // no new input since the halt
    assert.deepEqual(sent.slice(1), [zero, zero]);
    link.setInput(go); // the stick is still held when the page is back
    await step();
    assert.deepEqual(sent.at(-1), go);
  });

  test('one request at a time; the newest waiting command wins', async () => {
    const sent = [];
    const release = [];
    const link = new CommandLink({ send: c => new Promise((r) => { sent.push(c); release.push(r); }), now: () => 0 });
    link.setInput({ linear: 0.1, angular: 0, lamp: 0 });
    link.tick();
    await new Promise(r => setImmediate(r));
    link.setInput({ linear: 0.2, angular: 0, lamp: 0 });
    link.tick();
    link.setInput({ linear: 0.3, angular: 0, lamp: 0 });
    link.tick();
    await new Promise(r => setImmediate(r));
    assert.equal(sent.length, 1);
    release[0]();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(sent.map(c => c.linear), [0.1, 0.3]);
  });

  test('a failed request is remembered as no link', async () => {
    const link = new CommandLink({ send: async () => { throw new Error('offline'); }, now: () => 0 });
    link.setInput(go);
    link.tick();
    await new Promise(r => setImmediate(r));
    assert.equal(link.ok, false);
  });
});

describe('seeing exactly what the camera sees', async () => {
  const { pictureSize, verticalFov, desktopFov, yawOf, forwardOf, cameraFov, CAMERAS } = await import('../rover/view.js');
  const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

  test('a picture at distance d spans the camera field of view from the eye', () => {
    for (const fov of [60, 90, 120, 150]) {
      const d = 4;
      const { width, height } = pictureSize(fov, 16 / 9, d);
      close(2 * Math.atan(width / 2 / d) * 180 / Math.PI, fov);
      close(2 * Math.atan(height / 2 / d) * 180 / Math.PI, verticalFov(fov, 16 / 9));
    }
  });

  test('the desktop view fits the whole picture in any window shape', () => {
    const fov = 120;
    const aspect = 16 / 9;
    for (const win of [0.5, 1, aspect, 3]) {
      const fy = desktopFov(fov, aspect, win) * Math.PI / 180;
      const fx = 2 * Math.atan(Math.tan(fy / 2) * win);
      assert.ok(fy / 2 >= Math.atan(Math.tan(fov * Math.PI / 360) / aspect) - 1e-9, `height fits at ${win}`);
      assert.ok(fx * 180 / Math.PI >= fov - 1e-6, `width fits at ${win}`);
    }
    // In a window of the picture's own shape the picture fills it exactly.
    close(desktopFov(fov, aspect, aspect), verticalFov(fov, aspect), 1e-9);
  });

  test('heading comes from where you look, ignoring pitch; undefined straight up keeps the old one', () => {
    close(yawOf(0, -1), 0);
    close(yawOf(-1, 0), Math.PI / 2); // looking toward -X is a quarter turn left (+Y)
    assert.equal(yawOf(0, 0, 0.7), 0.7);
    const q = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)]; // a quarter turn about +Y
    const f = forwardOf(...q);
    close(f.x, -1);
    close(f.z, 0, 1e-12);
    close(yawOf(f.x, f.z), Math.PI / 2);
  });

  test('fisheye: each pixel goes back to the direction it was seen from (the Mini+ lens, as published)', async () => {
    const { fisheyeDirection, domeMesh, domeDrop } = await import('../rover/view.js');
    const angle = d => Math.acos(-d.z) * 180 / Math.PI; // off the camera axis
    const aspect = 16 / 9;
    const centre = fisheyeDirection(0.5, 0.5, 126, aspect);
    close(centre.z, -1);
    const right = fisheyeDirection(1, 0.5, 126, aspect);
    close(angle(right), 63, 1e-9);
    assert.ok(right.x > 0 && Math.abs(right.y) < 1e-12, 'right edge is to the right');
    const top = fisheyeDirection(0.5, 0, 126, aspect);
    assert.ok(top.y > 0, 'top row is up');
    // FrodoBots publishes H126 / V67 / D148 for the GC2093 module: the equisolid model lands within 1.5°.
    assert.ok(Math.abs(2 * angle(top) - 67) < 1.5, `vertical ${2 * angle(top)}°`);
    const corner = fisheyeDirection(1, 0, 126, aspect);
    assert.ok(Math.abs(2 * angle(corner) - 148) < 1.5, `diagonal ${2 * angle(corner)}°`);
    for (const d of [right, top, corner]) close(Math.hypot(d.x, d.y, d.z), 1, 1e-12);
    // A rectilinear lens 126° wide would be 96° tall: the picture is clearly a fisheye.
    assert.ok(Math.abs(verticalFov(126, aspect) - 96) < 1);

    const mesh = domeMesh(126, aspect, 4, 8, 4);
    assert.equal(mesh.positions.length, 9 * 5 * 3);
    assert.equal(mesh.indices.length, 8 * 4 * 6);
    // The picture is upright and not mirrored: the image's right half is on your right, its top row up.
    for (let k = 0; k < mesh.uvs.length / 2; k++) {
      const [u, v] = [mesh.uvs[2 * k], mesh.uvs[2 * k + 1]];
      const [x, y] = [mesh.positions[3 * k], mesh.positions[3 * k + 1]];
      if (Math.abs(u - 0.5) > 0.01) assert.equal(Math.sign(x), Math.sign(u - 0.5), `vertex ${k} left/right`);
      if (Math.abs(v - 0.5) > 0.01) assert.equal(Math.sign(y), Math.sign(0.5 - v), `vertex ${k} up/down`);
      assert.ok(mesh.positions[3 * k + 2] < 0, 'in front of you');
    }
    for (let k = 0; k < mesh.positions.length; k += 3) close(Math.hypot(mesh.positions[k], mesh.positions[k + 1], mesh.positions[k + 2]), 4, 1e-5);
    // First triangle faces the eye at the centre: its normal points back toward the origin.
    const p = i => [0, 1, 2].map(c => mesh.positions[mesh.indices[i] * 3 + c]);
    const [a, b, c] = [p(0), p(1), p(2)];
    const ab = a.map((v, i) => b[i] - v);
    const ac = a.map((v, i) => c[i] - v);
    const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    assert.ok(normal[0] * a[0] + normal[1] * a[1] + normal[2] * a[2] < 0, 'front face toward the viewer');
    close(domeDrop(126, aspect, 4), -fisheyeDirection(0.5, 1, 126, aspect).y * 4, 1e-12);
    assert.ok(domeDrop(126, aspect, 4) > 2 && domeDrop(126, aspect, 4) < 2.4, 'about 34° below the eye at 4 m');
  });

  test('the field of view can be tuned from the URL, within sane limits', () => {
    const p = s => new URLSearchParams(s);
    assert.equal(cameraFov('front', p('fov=95')), 95);
    assert.equal(cameraFov('rear', p('rearfov=80&fov=95')), 80);
    assert.equal(cameraFov('front', p('fov=500')), CAMERAS.front.hfov);
    assert.equal(cameraFov('front', p('fov=abc')), CAMERAS.front.hfov);
    assert.equal(cameraFov('front', p('')), CAMERAS.front.hfov);
  });
});

describe('where the page finds the rover API', async () => {
  const { apiBase, logEndpoint } = await import('../rover/api.js');
  test('on the PC the page uses its own server; the Quest app uses the PC through adb reverse', () => {
    assert.equal(apiBase({ hostname: 'localhost' }), '/rover-api');
    assert.equal(apiBase({ hostname: '127.0.0.1' }), '/rover-api');
    assert.equal(logEndpoint({ hostname: 'localhost' }), '/__log');
    assert.equal(apiBase({ hostname: 'seyedalicheraghi.github.io' }), 'http://localhost:8080/rover-api');
    assert.equal(logEndpoint({ hostname: 'example.github.io' }), 'http://localhost:8080/__log');
  });
});

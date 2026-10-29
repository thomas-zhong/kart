import assert from 'node:assert/strict';
import fs from 'node:fs';

const debugUrl = 'http://127.0.0.1:9223';
const gameUrl = 'http://127.0.0.1:8765/kart.html';
const tab = await (await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' })).json();
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let sequence = 0;
const pending = new Map();
const errors = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails);
  } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    errors.push(message.params.args.map(arg => arg.description || arg.value));
  } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    errors.push(message.params.entry);
  }
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 90000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression, awaitPromise = false) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function click(selector) {
  const point = await evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function key(code, pressed, modifiers = 0) {
  const names = { Space: ' ', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ShiftLeft: 'Shift' };
  const name = names[code] || (code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code);
  await send('Input.dispatchKeyEvent', { type: pressed ? 'keyDown' : 'keyUp', code, key: name, modifiers });
}
async function screenshot(name) {
  const image = await send('Page.captureScreenshot', { format: 'png' });
  const path = `/tmp/kart-racing-${name}.png`;
  fs.writeFileSync(path, Buffer.from(image.data, 'base64'));
  console.log(`Screenshot: ${path}`);
}
function pass(name) { console.log(`PASS ${name}`); }

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: gameUrl });
  const loaded = await evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 75000;
    function check() {
      if (typeof modelsReady !== 'undefined' && modelsReady) return resolve({
        mode, vehicles: vehicles.length, maps: maps.length,
        lapEnabled: !lapCountEl.disabled, startEnabled: !startButton.disabled,
        topSpeedBonus: NITRO_SPEED * 3.6, duration: NITRO_DURATION,
        effects: { flames: typeof updateFlames, skids: typeof recordSkidMarks, sparks: typeof emitWallSparks },
        effectCalls: {
          step: simulateStep.toString().includes('advanceEffects'),
          kart: updateKart.toString().includes('recordSkidMarks'),
          walls: resolveWalls.toString().includes('emitWallSparks')
        }
      });
      if (performance.now() > deadline) return reject(new Error(document.getElementById('load-status')?.textContent || 'Game load timeout'));
      setTimeout(check, 100);
    }
    check();
  })`, true);
  console.log('Loaded:', JSON.stringify(loaded));
  assert.equal(loaded.vehicles, 4);
  assert.equal(loaded.maps, 2);
  assert.equal(loaded.lapEnabled, true);
  assert.equal(loaded.startEnabled, true);
  pass('Four cars, both Blender maps and editable lap count load');
  await screenshot('garage');
  if (process.argv.includes('--probe')) {
    console.log('Runtime errors:', JSON.stringify(errors));
  } else {
    const lapChecks = await evaluate(`(() => {
      const results = [];
      for (const value of ['1', '3', '12', '9007199254740991', '', '0', '-1', '1.5', '1e3', '9007199254740992']) {
        lapCountEl.value = value;
        lapCountEl.dispatchEvent(new Event('input', { bubbles: true }));
        const expected = ['1', '3', '12', '9007199254740991'].includes(value);
        if (startButton.disabled === expected || lapErrorEl.hidden !== expected || lapCountEl.getAttribute('aria-invalid') !== String(!expected)) throw new Error('Lap validation: ' + value);
        if (!expected) {
          startRace();
          if (mode !== 'garage') throw new Error('Invalid lap count started race: ' + value);
        }
        results.push(value || '<empty>');
      }
      lapCountEl.value = '3'; lapCountEl.dispatchEvent(new Event('input', { bubbles: true }));
      return results;
    })()`);
    pass(`Positive integer validation: ${lapChecks.join(', ')}`);
    await evaluate("lapCountEl.focus(); lapCountEl.value = ''");
    const before = await evaluate('selectedVehicle');
    await key('Digit2', true); await key('Digit2', false);
    await send('Input.insertText', { text: '12' });
    assert.equal(await evaluate('selectedVehicle'), before);
    assert.equal(await evaluate('raceSettings.lapCount'), 12);
    pass('Typing lap count does not trigger vehicle shortcuts');
    await evaluate("lapCountEl.value = '3'; lapCountEl.dispatchEvent(new Event('input', { bubbles: true })); lapCountEl.blur()");
    await click('#start-race');
    assert.equal(await evaluate('mode'), 'race');
    await key('Digit2', true); await key('Digit2', false);
    assert.equal(await evaluate('currentGear'), 2);
    await key('KeyW', true);
    const driving = await evaluate('new Promise(resolve => setTimeout(() => resolve({ moved: pos.distanceTo(startPosition), speed: velocity.length() * 3.6 }), 1200))', true);
    await key('KeyW', false);
    assert.ok(driving.moved > 2 && driving.speed > 10);
    pass('Actual keyboard throttle, gear selection and rendered driving');
    await key('KeyR', true); await key('KeyR', false);
    await evaluate('window.requestAnimationFrame = () => 0');
    await evaluate('new Promise(resolve => setTimeout(resolve, 100))', true);
    const nitroChecks = await evaluate(`(() => {
      const checks = [];
      for (let car = 0; car < vehicles.length; car++) {
        returnToGarage(); selectVehicle(car); startRace(); clearBots();
        nitroCharge = 99; activateNitro();
        if (nitroTime !== 0) throw new Error('Nitro activated before full charge');
        nitroCharge = 100; forward.set(Math.sin(heading), 0, Math.cos(heading)); velocity.copy(forward).multiplyScalar(-1); activateNitro();
        if (nitroTime !== 0 || nitroCharge !== 100) throw new Error('Nitro activated in reverse');
        velocity.set(0, 0, 0); activateNitro();
        const target = vehicles[car].maxSpeed + 70 / 3.6;
        if (Math.abs(velocity.length() - target) > 1e-6 || nitroTime !== 5 || !flameGroup.visible) throw new Error('Nitro start ' + car);
        const duration = nitroTime; activateNitro();
        if (nitroTime !== duration) throw new Error('Nitro retriggered');
        for (let tick = 0; tick < 600; tick++) {
          pos.copy(startPosition); heading = yawAt(idx0); releaseKeys();
          if (tick >= 120 && tick < 240) keys.KeyS = true;
          if (tick >= 240 && tick < 360) keys.ShiftLeft = true;
          if (tick >= 360 && tick < 480) keys.ShiftLeft = keys.KeyA = true;
          currentGear = tick % vehicles[car].gears.length + 1;
          simulateStep(1 / 120);
          if (Math.abs(velocity.length() - target) > 1e-5) throw new Error('Nitro not constant ' + car + ' tick ' + tick);
          if (tick === 598 && nitroTime <= 0) throw new Error('Nitro expired early');
        }
        updateFlames();
        if (nitroTime !== 0 || flameGroup.visible) throw new Error('Nitro did not expire at 5 seconds');
        releaseKeys(); const speedBefore = velocity.length(); simulateStep(1 / 120);
        if (!(velocity.length() < speedBefore)) throw new Error('Normal slowdown not restored');
        nitroCharge = 100; activateNitro(); resetKart();
        if (nitroTime !== 0 || nitroCharge !== 0 || flameGroup.visible) throw new Error('Reset does not clear nitro');
        checks.push({ car: vehicles[car].name, topSpeedKmh: Math.round(target * 3.6), duration: 5 });
      }
      return checks;
    })()`);
    console.log('Nitro:', JSON.stringify(nitroChecks));
    pass('All four cars: +70 km/h, exact 5 seconds, controls, retrigger, reverse, expiry and reset');
    assert.deepEqual(errors, []);
    console.log('ALL CURRENT CHECKS PASS');
  }
} finally {
  socket.close();
  await fetch(`${debugUrl}/json/close/${tab.id}`).catch(() => {});
}

import assert from 'node:assert/strict';
import fs from 'node:fs';

const debugUrl = process.env.KART_CDP_URL || 'http://127.0.0.1:9223';
const gameUrl = process.env.KART_URL || 'http://127.0.0.1:8765/kart.html';
const tab = await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let sequence = 0;
const pending = new Map(), errors = [], warnings = [], checks = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails);
  } else if (message.method === 'Runtime.consoleAPICalled') {
    const text = message.params.args.map(arg => arg.description || arg.value).join(' ');
    if (message.params.type === 'error') errors.push(text);
    if (message.params.type === 'warning') warnings.push(text);
  } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    errors.push(message.params.entry);
  }
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 120000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression, awaitPromise = false) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
function check(name, condition, details) {
  assert.ok(condition, `${name}: ${JSON.stringify(details)}`);
  checks.push(name); console.log(`PASS ${name}`);
}
async function key(code, pressed, virtualKey, keyName) {
  await call('Input.dispatchKeyEvent', { type: pressed ? 'keyDown' : 'keyUp', code,
    key: keyName || (code === 'Space' ? ' ' : code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code),
    windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
}
async function click(selector) {
  const point = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({ block: 'center' }); const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function screenshot(name) {
  const image = await call('Page.captureScreenshot', { format: 'png' });
  const path = `/tmp/kart-regression-${name}.png`;
  fs.writeFileSync(path, Buffer.from(image.data, 'base64')); console.log(`Screenshot ${path}`);
}
async function render() {
  await evaluate('kart.position.copy(pos); kart.rotation.y = heading; updateFlames(); updateHud(); resetCamera(); renderer.setScissorTest(false); renderer.setViewport(0,0,innerWidth,innerHeight); renderer.render(scene,camera)');
}
try {
  await call('Page.enable'); await call('Runtime.enable'); await call('Log.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: gameUrl });
  await call('Page.bringToFront');
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  const loaded = await evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 100000;
    function check() {
      if (typeof modelsReady !== 'undefined' && modelsReady) return resolve({ vehicles: vehicles.length, maps: maps.length, lapEnabled: !lapCountEl.disabled, startEnabled: !startButton.disabled, tires: vehicles.map(v => v.rearTires.length), exhausts: vehicles.map(v => v.exhausts.length) });
      if (performance.now() > deadline) return reject(new Error(document.getElementById('load-status')?.textContent || 'Loading timeout'));
      setTimeout(check, 100);
    } check();
  })`, true);
  check('Four cars and two Blender maps load; lap input is enabled', loaded.vehicles === 4 && loaded.maps === 2 && loaded.lapEnabled && loaded.startEnabled && loaded.tires.every(n => n === 2), loaded);
  await screenshot('garage');

  const inputs = await evaluate(`(() => {
    const results = [];
    for (const value of ['1','3','12','9007199254740991','','0','-2','1.5','1e2','9007199254740992']) {
      lapCountEl.value = value; lapCountEl.dispatchEvent(new Event('input', { bubbles: true }));
      results.push({ value, valid: !startButton.disabled, invalid: lapCountEl.getAttribute('aria-invalid'), error: !lapErrorEl.hidden });
      if (startButton.disabled) { startRace(); if (mode !== 'garage') throw new Error('Invalid input started race'); }
    }
    lapCountEl.value = '3'; lapCountEl.dispatchEvent(new Event('input', { bubbles: true })); return results;
  })()`);
  check('Positive integers accepted; empty, zero, negatives, decimals and unsafe integers rejected', inputs.every((result, i) => result.valid === (i < 4) && result.error === (i >= 4)), inputs);
  await evaluate("lapCountEl.focus(); lapCountEl.value = ''");
  await call('Input.insertText', { text: '12' });
  const selected = await evaluate('selectedVehicle');
  await key('Digit3', true, 51, '3'); await key('Digit3', false, 51, '3');
  check('Typing in lap input does not select another car', await evaluate('selectedVehicle') === selected);
  await evaluate("lapCountEl.value = '3'; lapCountEl.dispatchEvent(new Event('input', { bubbles: true })); lapCountEl.blur()");
  await click('#start-race');
  console.log('Start diagnostic:', await evaluate('({ mode, hidden: document.hidden, focus: document.activeElement?.id, disabled:startButton.disabled, lap:lapCountEl.value, valid:lapCountEl.validity.valid, keys:Object.keys(keys) })'), errors);
  check('Mouse start enters the race', await evaluate('mode === "race"'));
  await key('Digit2', true, 50); await key('Digit2', false, 50);
  await key('KeyW', true, 87);
  const drove = await evaluate('new Promise(resolve => setTimeout(() => resolve({ moved: pos.distanceTo(startPosition), speed: velocity.length() * 3.6, charge: nitroCharge }), 1600))', true);
  await key('KeyW', false, 87);
  check('Real keyboard throttle drives the car without drift charge', drove.moved > 2 && drove.speed > 10 && drove.charge === 0, drove);
  await key('KeyR', true, 82); await key('KeyR', false, 82);
  await evaluate('window.requestAnimationFrame = () => 0');
  await evaluate('new Promise(resolve => setTimeout(resolve, 100))', true);

  const nitroTests = await evaluate(`(() => {
    const results = [];
    for (let index = 0; index < vehicles.length; index++) {
      returnToGarage(); selectVehicle(index); startRace(); clearBots();
      activateNitro(); if (nitroTime !== 0) throw new Error('Uncharged boost activated');
      nitroCharge = 100; forward.set(Math.sin(heading),0,Math.cos(heading)); velocity.copy(forward).multiplyScalar(-2);
      activateNitro(); if (nitroTime !== 0 || nitroCharge !== 100) throw new Error('Reverse boost activated');
      velocity.set(0,0,0); activateNitro();
      const target = activeVehicle.maxSpeed * 3.6 + 70;
      if (Math.abs(velocity.length()*3.6-target)>1e-7 || nitroTime !== 5 || !flameGroup.visible) throw new Error('Wrong boost initial state');
      const startTime = nitroTime; activateNitro(); if (nitroTime !== startTime) throw new Error('Boost was extended');
      let maximumError = 0;
      for (let tick = 0; tick < 600; tick++) {
        releaseKeys(); pos.copy(startPosition); heading = yawAt(idx0); collisionTime = slideTime = 0;
        if (tick % 4 === 0) keys.KeyS = true;
        if (tick % 4 === 1) keys.ShiftLeft = true;
        if (tick % 4 === 2) keys.KeyW = true;
        currentGear = 1 + tick % activeVehicle.gears.length;
        simulateStep(1/120); maximumError = Math.max(maximumError, Math.abs(velocity.length()*3.6-target));
        if (tick === 598 && nitroTime <= 0) throw new Error('Boost expired early');
      }
      updateFlames(); if (nitroTime !== 0 || flameGroup.visible || nitroCharge !== 0 || maximumError > 1e-6) throw new Error('Boost duration/constant speed failed');
      releaseKeys(); keys.KeyS = true; pos.copy(startPosition); simulateStep(1/120);
      if (velocity.length()*3.6 >= target) throw new Error('Normal brake did not return');
      results.push({ name: activeVehicle.name, target, maximumError, flameCount: activeVehicle.exhausts.length });
    }
    return results;
  })()`);
  check('All four cars: +70 km/h for exactly 5 seconds, unaffected by gear/brake/coast/handbrake', nitroTests.length === 4, nitroTests);
  console.log(JSON.stringify(nitroTests));

  const driftTests = await evaluate(`(() => {
    returnToGarage(); selectVehicle(0); startRace(); clearBots(); resetKart(true);
    keys.KeyW = keys.KeyA = keys.ShiftLeft = true;
    const sample = trackSample(0), dt = 1/120;
    function validTick(tick) {
      const p = trackSample(70 + tick * .17); pos.copy(p.position); heading = p.heading; turnDirection = 1;
      forward.set(Math.sin(heading),0,Math.cos(heading)); right.set(forward.z,0,-forward.x);
      velocity.copy(forward).multiplyScalar(20).addScaledVector(right, 7); collisionTime = slideTime = 0;
      updateKart(dt);
    }
    for (let tick = 0; tick < 299; tick++) validTick(tick);
    const before = nitroCharge;
    validTick(299);
    const result = { before, charge: nitroCharge, count: skidCount, draw: skidGeometry.drawRange.count, active: tireTracks.every(t=>t.active), heights: [...skidPositions].filter((_,i)=>i%3===1).slice(0,skidCount*4) };
    if (nitroCharge !== 100 || before >= 100 || skidCount < 20 || !drifting) throw new Error('Drift charging/skids missing');
    releaseKeys(); updateKart(dt); if (tireTracks.some(t=>t.active)) throw new Error('Stopped drift connected marks');
    return result;
  })()`);
  check('Real drift predicate charges in 2.5 seconds and creates two continuous rear-tire tracks', driftTests.charge === 100 && driftTests.count > 20 && driftTests.heights.every(y => Math.abs(y-.048)<1e-6), { ...driftTests, heights: driftTests.heights.slice(0,4) });
  await render(); await screenshot('skids');
  await key('Space', true, 32); await key('Space', false, 32);
  check('Real Space input activates tail fire', await evaluate('nitroTime === 5 && flameGroup.visible'));
  await render(); await screenshot('nitro');

  const wallTests = await evaluate(`(() => {
    resetKart(true); clearBots();
    const wall = wallSegments.find(w=>w.halfLength>.5);
    heading = Math.atan2(wall.tangent.x,wall.tangent.z);
    for (let i=0;i<12;i++) {
      pos.copy(wall.a).addScaledVector(wall.tangent,wall.halfLength).addScaledVector(wall.inward,activeVehicle.halfWidth-.02);
      velocity.copy(wall.tangent).multiplyScalar(25).addScaledVector(wall.inward,-5);
      advanceEffects(1/120); resolveWalls(1/120);
    }
    const emitted = sparks.filter(s=>s.life>0).length;
    const contactDistance = Math.abs(wallContact.clone().sub(wall.a).dot(wall.inward));
    if (!emitted || collisionKind !== 'scrape') throw new Error('Actual scrape has no sparks');
    const normal = velocity.dot(wall.inward);
    updateNearest(); kart.position.copy(pos); kart.rotation.y=heading;
    return { emitted, contactDistance, normal, kind:collisionKind, wallIndex:wallSegments.indexOf(wall) };
  })()`);
  check('Actual glancing wall collision emits sparks at the wall and keeps collision response', wallTests.emitted > 0 && wallTests.contactDistance < .1 && wallTests.normal >= 0, wallTests);
  await render(); await screenshot('sparks');
  const cleanup = await evaluate(`(() => {
    advanceEffects(.6); const expired = sparks.every(s=>s.life===0);
    const wall = wallSegments[${wallTests.wallIndex}]; clearEffects();
    heading = Math.atan2(-wall.inward.x,-wall.inward.z);
    pos.copy(wall.a).addScaledVector(wall.tangent,wall.halfLength).addScaledVector(wall.inward,activeVehicle.halfLength-.03);
    velocity.copy(wall.inward).multiplyScalar(-20); resolveWalls(1/120);
    const headOn = sparks.every(s=>s.life===0) && collisionKind==='bounce' && velocity.dot(wall.inward)>0;
    nitroCharge=100; velocity.set(0,0,0); activateNitro(); resetKart();
    const reset = !flameGroup.visible && skidCount===0 && sparks.every(s=>s.life===0) && nitroTime===0;
    returnToGarage(); const garageClean = !flameGroup.visible && skidCount===0;
    return { expired, headOn, reset, garageClean };
  })()`);
  check('Sparks expire; head-on collisions are distinct; reset and garage clear every effect', Object.values(cleanup).every(Boolean), cleanup);

  const finishTests = await evaluate(`(() => {
    lapCountEl.value='1'; validateLapCount(); startRace(); clearBots();
    for (let i=1;i<=N;i++) { const previous=playerRaceDistance; pos.copy(center[i%N]); updateNearest(); updateFinishers(1/120,previous); }
    if (mode!=='finished' || laps!==1 || playerFinish.rank!==1 || resultEl.hidden) throw new Error('One full lap did not finish');
    const resultText = document.getElementById('result-details').textContent;
    startRace(); const restarted = laps===0 && raceTime===0 && playerFinish===null && finishers.length===0 && resultEl.hidden;
    resetKart(true); clearBots(); pos.copy(center[N-1]); updateNearest(); pos.copy(center[0]); updateNearest();
    const noShortcut = laps===0;
    resetKart(true); createBots(); const target=trackLen, bot=bots[0]; bot.previousDistance=target-1; bot.distance=target+1;
    updateFinishers(.1,0); const botFirst=bot.finish===1 && playerFinish===null;
    clearBots(); for(let i=1;i<=N;i++){const previous=playerRaceDistance;pos.copy(center[i%N]);updateNearest();updateFinishers(1/120,previous);}
    const playerSecond=playerFinish?.rank===2;
    return { resultText, restarted, noShortcut, botFirst, playerSecond };
  })()`);
  check('Configured lap count finishes, records arrival order, restarts cleanly and rejects start-line shortcuts', finishTests.restarted && finishTests.noShortcut && finishTests.botFirst && finishTests.playerSecond, finishTests);
  await render(); await screenshot('finish');
  await click('#race-again'); check('Result restart button starts a fresh race', await evaluate('mode === "race" && laps===0 && playerFinish===null'));
  await key('Escape', true, 27); await key('Escape', false, 27);
  for (const map of ['#choose-hill','#choose-city']) {
    await click(map);
    for (const count of [2,3,4,5]) {
      const geometry = await evaluate(`(() => { laneCountEl.value='${count}';laneCountEl.dispatchEvent(new Event('change',{bubbles:true}));let visible=0;maps[selectedMap].laneVariants.forEach(v=>{if(v.visible)visible++});return { lanes:LANE_COUNT,walls:wallSegments.length,N,visible }; })()`);
      check(`${map}: ${count} lanes preserve matching Blender geometry and walls`, geometry.lanes === count && geometry.visible === 1 && geometry.walls === geometry.N * 2, geometry);
    }
  }
  for (const [name,width,height] of [['mobile',390,844],['short',844,390]]) {
    await call('Emulation.setDeviceMetricsOverride', { width,height,deviceScaleFactor:1,mobile:false });
    await evaluate('renderGarage()'); await screenshot(name);
    const layout=await evaluate(`(() => { const garageBox=garage.getBoundingClientRect(); return { overflow:garage.scrollWidth>garage.clientWidth+1, inputWidth:lapCountEl.getBoundingClientRect().width, garageWidth:garageBox.width }; })()`);
    check(`${name} garage: lap control fits without horizontal overflow`, !layout.overflow && layout.inputWidth>30, layout);
  }
  check('No browser JavaScript or WebGL errors', errors.length === 0, errors);
  console.log(`ALL ${checks.length} CHECKS PASS`);
  if(warnings.length) console.log('Browser warnings:',JSON.stringify([...new Set(warnings)]));
} finally {
  socket.close();
  for (const request of pending.values()) clearTimeout(request.timeout);
  await fetch(`${debugUrl}/json/close/${tab.id}`).catch(() => {});
}

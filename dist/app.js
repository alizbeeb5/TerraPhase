'use strict';

const $ = id => document.getElementById(id);
const canvas = $('map');
const context = canvas.getContext('2d');
const images = new Map();
const number = (value, digits = 1) => value.toLocaleString('en-US', {maximumFractionDigits: digits});
const db = value => (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value).toFixed(2) + ' dB';
const shortDate = date => new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
const state = {mode:new URLSearchParams(location.search).has('scene')?'nisar':'observed', view:'optical', step:0, location:'patch', slope:false, zoom:false, timer:0};
const views = {
  observed:[['optical','Before / after'],['change','Radar alerts'],['vh','VH'],['vv','VV'],['reference','Loss reference']],
  lesson:[['change','Radar alerts'],['hv','HV'],['hh','HH']],
};
let observed;
let loadError;
let observedTerrain;
const LAB_N = 176;
const labDates = ['Baseline', 'Pass 2', 'Pass 3', 'Pass 4', 'Pass 5'];
const labSites = [
  {id:'patch', title:'Simulated clearing', x:.36, y:.58},
  {id:'control', title:'Simulated radar shadow', x:.73, y:.35},
];
const lessonInfo = [
  'Start with a radar baseline over a virtual forest and ridge.',
  'A road branches into the forest. Changes begin to appear in the cross-polarized return.',
  'A darker patch also appears on a hillside. Turn on the slope overlay and click B.',
  'On the next pass the hillside alert fades while the road-side clearing stays visible.',
  'Compare the two locations over time. Persistent change supports follow-up, and steep terrain highlights a possible imaging artifact.',
];
const samples = Array.from({length:LAB_N * LAB_N}, (_, i) => {
  const x = (i % LAB_N + .5) / LAB_N, y = (Math.floor(i / LAB_N) + .5) / LAB_N;
  const ridge = .70 + .085 * Math.sin(y * 6.5);
  const z = .075 + .70 * Math.exp(-(((x - ridge) / .085) ** 2)) * (.66 + .23 * Math.cos((y - .34) * 8))
    + .031 * Math.sin(x * 19 + y * 11) + .024 * Math.cos(y * 29 - x * 16);
  return {x,y,z};
});

function simulated(index, step) {
  const {x,y,z} = samples[index];
  const phase = step / 4;
  const road = .57 + (x - .36) * .17 + .006 * Math.sin(34 * x);
  const spur = Math.min(...[.24,.36,.48,.59].map(branch =>
    Math.abs(x - branch + (y - road) * .18) + Math.max(0,Math.abs(y - road) - phase * .18)));
  const pattern = Math.min(Math.abs(y - road) * .76, spur);
  const jitter = Math.sin(x * 49 + y * 51) * Math.cos(y * 72 - x * 16) * .013;
  const cleared = step > 0 && x > .14 && x < .67 && x < .34 + phase * .40 && pattern + jitter < .009 + .027 * phase;
  const shadow = step === 2 && ((x - .73) / .034) ** 2 + ((y - .35) / .14) ** 2 < 1;
  const noise = Math.sin(index * 42.174 + step * 11.31) * .63 + Math.cos(x * 137 + y * 93 + step * 5) * .55;
  const col = index % LAB_N;
  const previous = samples[col ? index - 1 : index].z;
  const slope = Math.atan(Math.abs(z - previous) * 53) * 180 / Math.PI;
  const change = noise - (cleared ? 7.7 : 0) - (shadow ? 6.1 : 0);
  return {hv:-13.6 + 3.8 * z + change, hh:-9 + 2.9 * z + .67 * change, slope, z};
}

function labColor(index) {
  const curr = simulated(index, state.step), baseline = simulated(index, 0);
  const delta = curr.hv - baseline.hv;
  const alert = state.view === 'change' && delta < -3.5;
  const steep = state.slope && curr.slope > 25;
  if (alert && (!steep || index % LAB_N % 6 < 3)) return [242,139 + Math.round(Math.max(-9,delta)*4),58];
  if (steep) return [140,78,177];
  const signal = state.view === 'hh' ? curr.hh - 4.6 : curr.hv;
  const t = Math.max(0, Math.min(1, (signal + 24) / 15));
  return [Math.round(21 + 162*t), Math.round(36 + 169*t), Math.round(30 + 138*t)];
}

function getImage(name) {
  if (!images.has(name)) {
    const img = new Image();
    const ready = new Promise((resolve,reject) => {
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Unable to load ' + name));
    });
    img.src = './data/' + name + '.png';
    images.set(name, ready);
    ready.catch(() => images.delete(name));
  }
  return images.get(name);
}

let revision = 0;
async function draw() {
  const current = ++revision;
  if (state.mode === 'nisar') return;
  const lesson = state.mode === 'lesson';
  if (!lesson && !observed) return;
  $('map-error').hidden = true;
  if (lesson) {
    canvas.width = LAB_N;
    canvas.height = LAB_N;
    const frame = context.createImageData(LAB_N,LAB_N);
    for (let i = 0; i < samples.length; i++) {
      const [r,g,b] = labColor(i);
      frame.data.set([r,g,b,255],i*4);
    }
    context.putImageData(frame,0,0);
    if ($('terrain').open) drawTerrain();
    return;
  }
  try {
    const {width,height} = observed;
    const step = state.step;
    const view = state.view;
    const overlay = state.slope;
    const location = state.location;
    const base = view === 'optical' ? 'optical-1' : view === 'vv' ? 'vv-' + step : 'vh-' + step;
    const layers = [base];
    if (view === 'optical') layers.push('optical-0');
    if (view === 'optical' && location === 'patch') layers.push('outline');
    if (view === 'optical' && location === 'control') layers.push('control');
    if (view === 'change') layers.push('alert-' + step);
    if (view === 'reference') layers.push('reference');
    if (overlay) layers.push('slope');
    if (view === 'change' && location === 'control') layers.push('control');
    if (view === 'change' && location === 'patch' && step === observed.radar.length - 1) layers.push('selected');
    const results = await Promise.all(layers.map(getImage));
    if (current !== revision) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.drawImage(results[0],0,0);
    let start = 1;
    if (view === 'optical') {
      const frame = mapFrame();
      const line = width * (Number($('swipe').value) / 100 / frame.factor + frame.left);
      context.save();
      context.beginPath();
      context.rect(0,0,line,height);
      context.clip();
      context.drawImage(results[1],0,0);
      context.restore();
      start = 2;
    }
    for (let i = start; i < results.length; i++) context.drawImage(results[i],0,0);
    if ($('terrain').open) drawTerrain();
  } catch (error) {
    if (current !== revision) return;
    $('map-error').textContent = 'An image could not load. Retry by switching layers.';
    $('map-error').hidden = false;
    console.error(error);
  }
}

function setPlay(active) {
  clearInterval(state.timer);
  state.timer = 0;
  $('play').textContent = active ? 'Ⅱ' : '▶︎';
  $('play').setAttribute('aria-pressed', String(active));
  $('play').setAttribute('aria-label', (active ? 'Pause' : 'Play') + ' acquisition timeline');
  if (active) {
    setStep(0);
    state.timer = setInterval(() => {
      const length = state.mode === 'lesson' ? labDates.length : observed.radar.length;
      if (state.step + 1 >= length) setPlay(false);
      else setStep(state.step + 1);
    }, 1250);
  }
}

function setStep(step) {
  state.step = step;
  if (state.mode === 'observed' && state.view === 'optical') state.view = 'change';
  update();
}

function switchMode(mode) {
  if (mode === 'nisar') {
    setPlay(false); state.mode='nisar'; state.view='hh';
    window.NisarIntegration?.enter(); return;
  }
  window.NisarIntegration?.leave();
  setPlay(false);
  state.mode = mode;
  state.view = mode === 'lesson' ? 'change' : 'optical';
  state.step = mode === 'lesson' ? 0 : Math.max(0,(observed?.radar.length ?? 1)-1);
  state.location = 'patch';
  state.slope = false;
  state.zoom = false;
  update();
}

function button(label, action, pressed, className) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  if (className) el.className = className;
  if (pressed !== undefined) el.setAttribute('aria-pressed',String(pressed));
  el.addEventListener('click',action);
  return el;
}

function selectLocation(id) {
  state.location = id;
  update();
}

function mapFrame() {
  if (!state.zoom || state.mode === 'lesson' || !observed) return {factor:1,left:0,top:0};
  const site = observed.patches.find(x => x.id === state.location);
  const clamp = value => Math.max(0,Math.min(.75,value));
  return {factor:4,left:clamp(site.x - .125),top:clamp(site.y - .125)};
}

function setMapUI(lesson) {
  const compare = !lesson && state.view === 'optical';
  $('image-area').style.aspectRatio = lesson ? '1.55' : observed ? observed.width / observed.height : '1.7';
  $('image-area').classList.toggle('is-lesson',lesson);
  const {factor,left,top} = mapFrame();
  canvas.style.width = (factor * 100) + '%';
  canvas.style.height = (factor * 100) + '%';
  canvas.style.left = (-left * factor * 100) + '%';
  canvas.style.top = (-top * factor * 100) + '%';
  $('zoom').hidden = lesson || !observed;
  $('zoom').textContent = state.zoom ? 'Show full area' : 'Zoom to selection';
  $('zoom').setAttribute('aria-pressed',String(state.zoom));
  const locations = lesson ? labSites : observed?.patches ?? [];
  locations.forEach((site,i) => {
    const pin = $('markers').children[i];
    const x = (site.x - left) * factor, y = (site.y - top) * factor;
    pin.style.left = (x * 100) + '%';
    pin.style.top = (y * 100) + '%';
    pin.hidden = x < .06 || x > .94 || y < .06 || y > .94 || (state.zoom && site.id === state.location);
  });
  $('map').setAttribute('aria-label',lesson ? 'Simulated forest radar scene' : 'Satellite imagery over Rondônia, Brazil');
  $('swipe').hidden = !compare;
  $('divider').hidden = !compare;
  $('divider').style.left = $('swipe').value + '%';
  $('before-label').hidden = !lesson && !observed;
  $('after-label').hidden = !compare || !observed;
  if (lesson) $('before-label').textContent = 'SIMULATED L-BAND';
  else if (observed && compare) {
    $('before-label').textContent = 'BEFORE · ' + observed.optical[0].date;
    $('after-label').textContent = 'AFTER · ' + observed.optical[1].date;
  } else if (observed) $('before-label').textContent = state.view === 'reference' ? 'ANNUAL LOSS · 2020–2022' : observed.radar[state.step].date;
  let legend;
  if (compare) legend = 'Sentinel‑2 true color <span><i class="swatch" style="background:#424c49"></i>Masked optical pixels</span>';
  else if (state.view === 'reference') legend = '<span><i class="swatch blue"></i>Independent tree-cover loss</span>';
  else if (state.view === 'change') legend = '<span><i class="swatch"></i>Cross-pol drop &gt; 3.5 dB</span>';
  else if (lesson) legend = 'Simulated ' + state.view.toUpperCase() + ' <span>Dark = lower backscatter</span>';
  else legend = state.view === 'vh' ? 'VH backscatter · −25 to −9 dB' : 'VV backscatter · −19 to −4 dB';
  if (state.slope) legend += ' <span><i class="swatch purple"></i>Slope &gt; 25°</span>';
  $('legend').innerHTML = legend;
  $('scale').hidden = lesson || !observed;
  if (!lesson && observed) {
    const metres = state.zoom ? 500 : 2000;
    $('scale').textContent = state.zoom ? '500 m' : '2 km';
    $('scale').style.width = (metres / observed.widthM * factor * 100) + '%';
  }
}

function coordinates(site) {
  return Math.abs(site.latitude).toFixed(4) + '° S · ' + Math.abs(site.longitude).toFixed(4) + '° W';
}

function metric(value,label) {
  return '<div class="metric"><strong>' + value + '</strong><span>' + label + '</span></div>';
}

function setEvidence(lesson) {
  if (!lesson && !observed) {
    $('evidence-body').textContent = loadError ? 'The case could not load. You can still open the Radar lab.' : 'Loading bundled observations…';
    return;
  }
  const locations = lesson ? labSites : observed.patches;
  const site = locations.find(x => x.id === state.location);
  const patch = site.id === 'patch';
  $('evidence-sub').textContent = lesson ? lessonInfo[state.step] : coordinates(site);
  if (lesson) {
    const ix = Math.floor(site.x * LAB_N), iy = Math.floor(site.y * LAB_N), idx = iy * LAB_N + ix;
    const val = simulated(idx,state.step), base = simulated(idx,0);
    const change = val.hv - base.hv;
    $('evidence-body').innerHTML = '<div class="metrics">' + metric(db(change),'Simulated HV change') +
      metric(Math.round(val.slope) + '°','Simulated local slope') + '</div><div class="facts"><p><strong>' +
      (patch ? 'A · Persistent pattern.' : 'B · Terrain-related artifact.') +
      '</strong> ' + (patch ? 'The model weakens the cross-polarized echo where it removes its artificial canopy.' :
        'The model darkens part of the hillside on Pass 3. The signal recovers on Pass 4.') +
      '</p><p>All observations and terrain here are generated for the lesson.</p></div>';
    return;
  }
  const item = site.series[state.step];
  const ref = patch ? 'Overlaps independently mapped annual tree-cover loss.' : 'No mapped tree-cover loss in the reference interval.';
  const repeat = patch ? site.series.filter(f => f.flaggedHa > site.areaHa * .9).length : 0;
  const acquisition = observed.stats[state.step];
  $('evidence-body').innerHTML = '<div class="metrics">' +
    metric(number(item.flaggedHa,2) + ' ha','Flagged in this footprint') +
    metric(db(item.delta),'Mean VH change vs baseline') +
    '</div><div class="facts"><p><strong>' + shortDate(observed.radar[state.step].date) +
    '.</strong> ' + (state.step === 0 ? 'Baseline acquisition.' : number(acquisition.areaHa,2) +
      ' ha flagged across the study area, including ' + number(acquisition.newHa,2) + ' ha flagged for the first time.') +
    '</p><p><strong>Loss reference.</strong> ' + number(site.referencePct) + '% of this footprint. ' + ref +
    '</p><p><strong>Repeat observations.</strong> ' + (patch ? repeat + ' acquisitions flagged more than 90% of this footprint.' :
      'The control stayed below the alert criteria on all displayed dates.') +
    '</p><p><strong>Terrain.</strong> ' + site.elevation.join('–') + ' m elevation. ' + number(site.steepPct) +
    '% of this footprint is steeper than 25°.</p><p><strong>Optical comparison.</strong> Sentinel‑2 shows surface conditions in ' +
    observed.optical[0].date.slice(0,4) + ' and ' + observed.optical[1].date.slice(0,4) + '.</p></div>';
}

function update() {
  if (state.mode === 'nisar') { window.NisarIntegration?.update(); return; }
  const lesson = state.mode === 'lesson';
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.mode === state.mode)));
  $('eyebrow').textContent = lesson ? 'SYNTHETIC APERTURE RADAR' : 'FOREST DISTURBANCE EXPLORER';
  $('heading').textContent = lesson ? 'Read the radar signal.' : 'Forest change, in focus.';
  $('subhead').textContent = lesson ? 'Step through a simulated clearing and see how a hillside can mimic change.' :
    'Compare satellite observations and inspect the evidence behind a forest disturbance alert.';
  $('dataset-status').classList.toggle('simulated',lesson);
  $('dataset-status').innerHTML = '<span></span> ' + (lesson ? 'NISAR-inspired simulation' : observed ? 'Observed satellite data' : loadError ? 'Case unavailable' : 'Loading case');
  $('stage-kicker').textContent = lesson ? 'SIMULATED SCENE' : 'STUDY AREA';
  $('site-title').textContent = lesson ? 'Forest and hillside' : observed?.title ?? 'Rondônia, Brazil';
  $('evidence-kicker').textContent = lesson ? 'GUIDED EXERCISE' : 'CASE EVIDENCE';
  $('evidence-title').textContent = lesson ? 'Clearing or radar shadow?' : 'Inspect the change';
  $('slope').checked = state.slope;
  $('slope').disabled = !lesson && !observed;
  $('orbit').hidden = !lesson && !observedTerrain;
  $('download').hidden = lesson || !observed;
  $('attribution').textContent = lesson ? 'Synthetic backscatter · educational simulation' :
    'Copernicus Sentinel‑1 & Sentinel‑2 · Copernicus DEM · Hansen / UMD';
  const layerbar = $('view-buttons');
  if (layerbar.dataset.mode !== state.mode) {
    layerbar.dataset.mode = state.mode;
    layerbar.replaceChildren(...views[state.mode].map(([key,name]) => {
      const control = button(name,() => { if (!lesson && !observed) return; setPlay(false); state.view=key; update(); }, false);
      control.dataset.view = key;
      return control;
    }));
  }
  [...layerbar.children].forEach(b => {
    b.disabled = !lesson && !observed;
    b.setAttribute('aria-pressed',String(b.dataset.view === state.view));
  });
  const locations = lesson ? labSites : observed?.patches ?? [];
  const strip = $('patch-list');
  if (strip.dataset.mode !== state.mode || strip.children.length !== locations.length) {
    strip.dataset.mode = state.mode;
    strip.replaceChildren(...locations.map((site,i) => {
      const control = button(site.title,() => selectLocation(site.id),false,site.id === 'control' ? 'control' : undefined);
      const letter = document.createElement('span');
      letter.className = 'marker';
      letter.textContent = i === 0 ? 'A' : 'B';
      control.prepend(letter);
      return control;
    }));
    $('markers').replaceChildren(...locations.map((site,i) => {
      const pin = button(i === 0 ? 'A' : 'B',() => selectLocation(site.id),false,'pin ' + site.id);
      pin.setAttribute('aria-label',site.title);
      pin.style.left = (100 * site.x) + '%';
      pin.style.top = (100 * site.y) + '%';
      return pin;
    }));
  }
  locations.forEach((site,i) => {
    const active = String(state.location === site.id);
    strip.children[i].setAttribute('aria-pressed',active);
    $('markers').children[i].setAttribute('aria-pressed',active);
  });
  const dates = lesson ? labDates : observed?.radar.map(x => x.date) ?? [];
  $('time-title').textContent = lesson ? 'SIMULATED PASSES' : 'RADAR ACQUISITIONS';
  $('date-range').max = Math.max(0,dates.length - 1);
  $('date-range').value = state.step;
  $('date-range').disabled = dates.length === 0;
  $('play').disabled = dates.length === 0;
  $('date').textContent = dates.length ? (lesson ? dates[state.step] : shortDate(dates[state.step])) : '—';
  $('date-range').setAttribute('aria-valuetext',$('date').textContent);
  const ticks = $('ticks');
  if (ticks.dataset.mode !== state.mode || ticks.children.length !== dates.length) {
    ticks.dataset.mode = state.mode;
    ticks.replaceChildren(...dates.map((d,i) => {
      const mark = button(lesson ? d : shortDate(d).replace(/ 20(\d\d)$/," ’$1"),() => {setPlay(false);setStep(i);});
      mark.setAttribute('aria-label',lesson ? d : shortDate(d));
      return mark;
    }));
  }
  [...ticks.children].forEach((b,i) => b.setAttribute('aria-current',String(i === state.step)));
  setMapUI(lesson);
  setEvidence(lesson);
  if (loadError && !lesson) {
    $('map-error').textContent = 'The case assets could not load.';
    $('map-error').hidden = false;
  } else draw();
}

function drawTerrain() {
  if (state.mode === 'nisar') { window.NisarIntegration?.drawTerrain(); return; }
  const terrain = $('terrain-canvas');
  const ctx = terrain.getContext('2d');
  const az = Number($('angle').value) * Math.PI / 180;
  const scale = Number($('exag').value);
  const lesson = state.mode === 'lesson';
  const grid = lesson ? null : observedTerrain;
  if (!lesson && (!grid || canvas.width !== observed.width)) return;
  const raster = lesson ? null : context.getImageData(0,0,canvas.width,canvas.height).data;
  const elevationMin = lesson ? 0 : Math.min(...grid.elevation);
  const columns = lesson ? 38 : grid.width, rows = lesson ? 38 : grid.height, polys = [];
  const c = Math.cos(az), s = Math.sin(az);
  function vertex(i,j) {
    const u = i / (columns - 1), v = j / (rows - 1);
    const x = Math.round(u * (LAB_N - 1)), y = Math.round(v * (LAB_N - 1));
    const index = y * LAB_N + x;
    const height = lesson ? samples[index].z * 68 : (grid.elevation[j * columns + i] - elevationMin) * .12;
    const a = (u - .5) * 408;
    const b = (v - .5) * (lesson ? 408 : 408 * observed.height / observed.width);
    const depth = a*s + b*c;
    const offset = (Math.round(v * (canvas.height - 1)) * canvas.width + Math.round(u * (canvas.width - 1))) * 4;
    return {x:340+a*c-b*s,y:227+depth*.48-height*scale,depth,color:lesson ? labColor(index) : raster.slice(offset,offset+3)};
  }
  const points = Array.from({length:rows},(_,j)=>Array.from({length:columns},(_,i)=>vertex(i,j)));
  for (let j=0;j<rows-1;j++) for (let i=0;i<columns-1;i++) {
    const face = [points[j][i],points[j][i+1],points[j+1][i+1],points[j+1][i]];
    polys.push({face,depth:face.reduce((sum,p)=>sum+p.depth,0),color:face[0].color});
  }
  ctx.clearRect(0,0,terrain.width,terrain.height);
  polys.sort((a,b)=>a.depth-b.depth);
  for (const {face,color} of polys) {
    ctx.beginPath();
    face.forEach(({x,y},i)=>i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
    ctx.closePath();
    const rgb = 'rgb(' + Array.from(color).join(',') + ')';
    ctx.fillStyle = rgb;
    ctx.strokeStyle = rgb;
    ctx.stroke();
    ctx.fill();
  }
}

function download() {
  if (state.mode === 'nisar') { window.NisarIntegration?.exportEvidence(); return; }
  const blob = new Blob([JSON.stringify({selectedAcquisition:observed.radar[state.step].date,selectedLocation:state.location,...observed},null,2)],{type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'canopy-watch-evidence.json';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click',()=>switchMode(b.dataset.mode)));
$('swipe').addEventListener('input',() => { $('divider').style.left = $('swipe').value + '%'; draw(); });
$('date-range').addEventListener('input',() => {setPlay(false);setStep(Number($('date-range').value));});
$('play').addEventListener('click',() => setPlay(!state.timer));
$('slope').addEventListener('change',() => {state.slope=$('slope').checked;update();});
$('download').addEventListener('click',download);
$('open-method').addEventListener('click',() => $('method').showModal());
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click',() => $(b.dataset.close).close()));
$('orbit').addEventListener('click',() => {
  setPlay(false);
  $('terrain-title').textContent = state.mode === 'nisar' ? 'NISAR image on real terrain' : state.mode === 'lesson' ? 'Simulated terrain' : 'Rondônia terrain';
  $('terrain').showModal();
  drawTerrain();
});
$('zoom').addEventListener('click',() => {if(state.mode==='nisar'){window.NisarIntegration?.toggleDetail();return;}state.zoom = !state.zoom; update();});
['angle','exag'].forEach(id => $(id).addEventListener('input',drawTerrain));
let drag;
$('terrain-canvas').addEventListener('pointerdown',event => {drag=event.clientX;event.currentTarget.setPointerCapture(event.pointerId);});
$('terrain-canvas').addEventListener('pointermove',event => {
  if (drag === undefined) return;
  const angle = Number($('angle').value) + (event.clientX-drag);
  $('angle').value = ((angle + 540) % 360) - 180;
  drag=event.clientX;
  drawTerrain();
});
['pointerup','pointercancel','lostpointercapture'].forEach(name => $('terrain-canvas').addEventListener(name,()=>{drag=undefined;}));
$('method-content').innerHTML = `
  <section><h3>Observed case · Rondônia, Brazil</h3><p>Sentinel‑1A radiometrically terrain-corrected C-band VH and VV power, descending relative orbit 83. Sentinel‑2 Level‑2A true-color images provide before-and-after context. Copernicus DEM GLO‑30 supplies terrain context. In the optical pair, pixels outside Sentinel‑2 scene classes 4, 5 and 6 are grayed out.</p></section>
  <section><h3>How alerts are calculated</h3><p>The analysis uses a common 20 m UTM grid. A 3 × 3 neighborhood mean in linear power reduces speckle before conversion to dB. A candidate has a VH drop greater than 3.5 dB against the 2019 baseline and belongs to a connected patch of at least 24 cells (0.96 ha). The forest proxy uses Hansen 2000 canopy cover of at least 30% and excludes mapped tree-cover loss through 2019. Only forest-proxy pixels valid on every radar date contribute. A first alert is counted once per cell.</p></section>
  <section><h3>What corroboration means</h3><p>The featured patch persisted on the final two radar dates and was selected for overlap with the independent Hansen annual loss layer. The stable comparison was selected using the same forest proxy, with no flagged or mapped-loss cells. These are case-study examples. The overlap is a local comparison and does not estimate model accuracy. Annual loss and optical changes provide corroboration without identifying the cause or establishing permanent land conversion.</p></section>
  <section><h3>Radar lab</h3><p>The simulated NISAR-style HH and HV signals illustrate a persistent clearing and a temporary terrain artifact. The 3D view uses the same synthetic elevation field as the lesson.</p></section>
  <section><h3>Sources</h3><p><a target="_blank" rel="noopener" href="https://planetarycomputer.microsoft.com/dataset/sentinel-1-rtc">Sentinel‑1 RTC catalog</a> · <a target="_blank" rel="noopener" href="https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a">Sentinel‑2 L2A catalog</a> · <a target="_blank" rel="noopener" href="https://developers.google.com/earth-engine/datasets/catalog/UMD_hansen_global_forest_change_2024_v1_12">Hansen / UMD tree-cover loss</a> · <a target="_blank" rel="noopener" href="https://registry.opendata.aws/copernicus-dem/">Copernicus DEM</a> · <a target="_blank" rel="noopener" href="https://nisar-docs.asf.alaska.edu/gcov/">NISAR GCOV guide</a></p></section>`;
update();
fetch('./data/case.json').then(response => {
  if (!response.ok) throw new Error('Case manifest ' + response.status);
  return response.json();
}).then(data => {
  observed=data;
  fetch('./data/terrain.json').then(response => {
    if (!response.ok) throw new Error('Terrain manifest ' + response.status);
    return response.json();
  }).then(terrain => {observedTerrain=terrain;update();}).catch(error => console.error(error));
  if (state.mode === 'observed') switchMode('observed');
  if(state.mode==='observed') for (let i=0;i<observed.radar.length;i++) getImage('vh-' + i).catch(()=>{});
}).catch(error => {loadError=error;update();});

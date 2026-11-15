const RAD = Math.PI / 180;
const DEFAULT_VIEW = { lon: -73, lat: 11, zoom: 1 };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrap = lon => ((lon + 180) % 360 + 360) % 360 - 180;

async function loadTexture() {
  const image = new Image();
  image.src = new URL('./natural-earth.png', import.meta.url);
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw Error('Globe rendering unavailable');
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function project(center, view, radius, width, height) {
  const lat = center.lat * RAD;
  const delta = (center.lon - view.lon) * RAD;
  const pitch = view.lat * RAD;
  const away = Math.cos(lat) * Math.cos(delta);
  return {
    x: width / 2 + radius * Math.cos(lat) * Math.sin(delta),
    y: height / 2 - radius * (Math.cos(pitch) * Math.sin(lat) - Math.sin(pitch) * away),
    depth: Math.sin(pitch) * Math.sin(lat) + Math.cos(pitch) * away,
  };
}

function groupPins(pins) {
  const groups = [];
  for (const pin of pins) {
    const neighbors = groups.filter(group => group.some(other => Math.hypot(other.x - pin.x, other.y - pin.y) < 41));
    for (const group of neighbors) groups.splice(groups.indexOf(group), 1);
    groups.push([pin, ...neighbors.flat()]);
  }
  return groups;
}

function drawSphere(frame, texture, radius, view) {
  const { width, height, data } = frame;
  const pitch = view.lat * RAD;
  const cos = Math.cos(pitch);
  const sin = Math.sin(pitch);
  const textureWidth = texture.width;
  const textureHeight = texture.height;
  const content = texture.data;
  const fromX = Math.max(0, Math.floor(width / 2 - radius));
  const fromY = Math.max(0, Math.floor(height / 2 - radius));
  const toX = Math.min(width, Math.ceil(width / 2 + radius));
  const toY = Math.min(height, Math.ceil(height / 2 + radius));
  data.fill(0);
  for (let row = fromY; row < toY; row++) {
    const y = (height / 2 - row - 0.5) / radius;
    for (let column = fromX; column < toX; column++) {
      const x = (column + 0.5 - width / 2) / radius;
      const r2 = x * x + y * y;
      if (r2 >= 1) continue;
      const z = Math.sqrt(1 - r2);
      const lat = Math.asin(clamp(y * cos + z * sin, -1, 1));
      const lon = Math.atan2(x, z * cos - y * sin) / RAD + view.lon;
      const u = Math.floor((wrap(lon) + 180) / 360 * textureWidth);
      const v = clamp(Math.floor((0.5 - lat / Math.PI) * textureHeight), 0, textureHeight - 1);
      const src = 4 * (v * textureWidth + u);
      const dest = 4 * (row * width + column);
      const shade = 0.80 + 0.20 * Math.max(0, 0.91 * z - 0.27 * x + 0.30 * y);
      data[dest] = content[src] * shade;
      data[dest + 1] = content[src + 1] * shade;
      data[dest + 2] = content[src + 2] * shade;
      data[dest + 3] = clamp((1 - Math.sqrt(r2)) * radius + 0.4, 0, 1) * 255;
    }
  }
}

export async function createGlobe({ canvas, pins, onSelect, zoomIn, zoomOut, reset, restoredView }) {
  const context = canvas.getContext('2d');
  if (!context) throw Error('Globe rendering unavailable');
  const texture = await loadTexture();
  const view = { ...DEFAULT_VIEW };
  if (restoredView && [restoredView.lon, restoredView.lat, restoredView.zoom].every(Number.isFinite)) {
    Object.assign(view, {
      lon: wrap(restoredView.lon), lat: clamp(restoredView.lat, -80, 80), zoom: clamp(restoredView.zoom, 0.8, 2.6),
    });
  }
  const markerElements = new Map();
  let events = [];
  let selected;
  let cluster;
  let pending;
  let frame;
  let drag;

  function makePin(key, group) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = group.length === 1 ? 'globe-pin' : 'globe-pin cluster';
    button.addEventListener('click', () => {
      if (group.length === 1) {
        onSelect(group[0].event.id);
      } else {
        cluster = cluster === key ? null : key;
        requestDraw();
      }
    });
    pins.append(button);
    return button;
  }

  function drawPins(width, height, radius) {
    const visible = events.flatMap(event => {
      if (!event.center || ![event.center.lon, event.center.lat].every(Number.isFinite)) return [];
      const point = project(event.center, view, radius, width, height);
      const inView = point.depth > 0 && point.x >= 17 && point.x <= width - 17 && point.y >= 17 && point.y <= height - 17;
      return inView ? [{ ...point, event }] : [];
    });
    const rendered = new Set();
    for (const group of groupPins(visible)) {
      const key = group.map(pin => pin.event.id).sort().join(',');
      const button = markerElements.get(key) ?? makePin(key, group);
      markerElements.set(key, button);
      rendered.add(key);
      const x = group.reduce((sum, pin) => sum + pin.x, 0) / group.length;
      const y = group.reduce((sum, pin) => sum + pin.y, 0) / group.length;
      button.style.left = x + 'px';
      button.style.top = y + 'px';
      if (group.length === 1) {
        button.setAttribute('aria-pressed', String(group[0].event.id === selected));
        button.title = group[0].event.name;
        button.setAttribute('aria-label', 'Select ' + group[0].event.name + ' on globe');
      } else {
        button.textContent = group.length;
        button.setAttribute('aria-label', group.length + ' study sites at this location');
        button.setAttribute('aria-expanded', String(cluster === key));
      }
      const menuKey = key + ':menu';
      if (group.length > 1 && cluster === key) {
        let menu = markerElements.get(menuKey);
        if (!menu) {
          menu = document.createElement('div');
          menu.className = 'pin-options';
          for (const { event } of group) {
            const item = document.createElement('button');
            item.type = 'button';
            item.textContent = event.name;
            item.addEventListener('click', () => {
              cluster = null;
              onSelect(event.id);
            });
            menu.append(item);
          }
          pins.append(menu);
          markerElements.set(menuKey, menu);
        }
        menu.style.left = clamp(x, 108, width - 108) + 'px';
        menu.style.top = Math.min(y, height - menu.offsetHeight - 26) + 'px';
        rendered.add(menuKey);
      }
    }
    for (const [key, element] of markerElements) {
      if (rendered.has(key)) continue;
      element.remove();
      markerElements.delete(key);
    }
  }

  function requestDraw() {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      const scale = Math.min(devicePixelRatio || 1, 1.2, 1000 / Math.max(width, height));
      const w = Math.round(width * scale);
      const h = Math.round(height * scale);
      if (!frame || canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        frame = context.createImageData(w, h);
      }
      const radius = Math.min(width, height) * 0.445 * view.zoom;
      drawSphere(frame, texture, radius * scale, view);
      context.putImageData(frame, 0, 0);
      drawPins(width, height, radius);
      zoomIn.disabled = view.zoom >= 2.6;
      zoomOut.disabled = view.zoom <= 0.8;
    });
  }

  function rotate(x, y) {
    cluster = null;
    view.lon = wrap(view.lon + x);
    view.lat = clamp(view.lat + y, -80, 80);
    requestDraw();
  }

  function zoom(factor) {
    cluster = null;
    view.zoom = clamp(view.zoom * factor, 0.8, 2.6);
    requestDraw();
  }

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    const sensitivity = 130 / (Math.min(canvas.clientWidth, canvas.clientHeight) * view.zoom);
    rotate((drag.x - event.clientX) * sensitivity, (event.clientY - drag.y) * sensitivity);
    drag.x = event.clientX;
    drag.y = event.clientY;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(type, event => { if (drag?.id === event.pointerId) drag = null; });
  }
  canvas.addEventListener('wheel', event => {
    // Preserve normal page scrolling until the user engages the globe.
    if (document.activeElement !== canvas && !event.ctrlKey) return;
    event.preventDefault();
    zoom(event.deltaY > 0 ? 0.90 : 1.11);
  }, { passive: false });
  const directions = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, 12], ArrowDown: [0, -12] };
  canvas.addEventListener('keydown', event => {
    if (Object.hasOwn(directions, event.key)) rotate(...directions[event.key]);
    else if (event.key === '+' || event.key === '=') zoom(1.25);
    else if (event.key === '-' || event.key === '−') zoom(0.8);
    else if (event.key === 'Home') reset.click();
    else return;
    event.preventDefault();
  });
  zoomIn.addEventListener('click', () => zoom(1.25));
  zoomOut.addEventListener('click', () => zoom(0.8));
  reset.addEventListener('click', () => {
    Object.assign(view, DEFAULT_VIEW);
    cluster = null;
    requestDraw();
  });
  new ResizeObserver(requestDraw).observe(canvas);
  requestDraw();

  return {
    setEvents(visibleEvents, selectedId) {
      events = visibleEvents;
      selected = selectedId;
      requestDraw();
    },
    focus(event) {
      if (!event.center || ![event.center.lon, event.center.lat].every(Number.isFinite)) return;
      cluster = null;
      view.lon = wrap(event.center.lon);
      view.lat = clamp(event.center.lat, -80, 80);
      requestDraw();
    },
    getView() { return { ...view }; },
  };
}

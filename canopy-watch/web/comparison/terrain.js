export function drawTerrain(canvas, image, terrain, grid, rotation, exaggeration) {
  canvas.width = 960;
  canvas.height = 570;
  const context = canvas.getContext('2d');
  const size = terrain.size;
  const texture = document.createElement('canvas');
  texture.width = size;
  texture.height = size;
  const tex = texture.getContext('2d');
  tex.drawImage(image, 0, 0, size, size);
  const rgba = tex.getImageData(0, 0, size, size).data;
  const angle = rotation * Math.PI / 180;
  const scale = 650 / Math.hypot(grid.widthM, grid.heightM);
  const center = (Math.min(...terrain.elevation) + Math.max(...terrain.elevation)) / 2;
  const relief = Math.max(...terrain.elevation) - Math.min(...terrain.elevation);
  const vertical = Math.min(scale * exaggeration, 330 / (relief || 1));
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const points = terrain.elevation.map((height, i) => {
    const x = (i % size / (size - 1) - .5) * grid.widthM * scale;
    const y = (Math.floor(i / size) / (size - 1) - .5) * grid.heightM * scale;
    const depth = x * s + y * c;
    return { x: 480 + x * c - y * s, y: 290 + depth * .50 - (height - center) * vertical, depth };
  });
  const faces = [];
  for (let j = 0; j < size - 1; j++) {
    for (let i = 0; i < size - 1; i++) {
      const k = j * size + i;
      if (!rgba[k * 4 + 3]) continue;
      const corners = [points[k], points[k + 1], points[k + size + 1], points[k + size]];
      faces.push({ corners, depth: corners.reduce((sum, point) => sum + point.depth, 0), k });
    }
  }
  faces.sort((a, b) => a.depth - b.depth);
  for (const { corners, k } of faces) {
    const base = k * 4;
    context.fillStyle = context.strokeStyle = 'rgb(' + rgba.slice(base, base + 3).join(',') + ')';
    context.beginPath();
    context.moveTo(corners[0].x, corners[0].y);
    corners.slice(1).forEach(point => context.lineTo(point.x, point.y));
    context.closePath();
    context.stroke();
    context.fill();
  }
}

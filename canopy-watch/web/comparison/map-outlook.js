// Geographic axes are shared by the hazard radar grids and regional maps.
export function mapPosition(bounds, width, height, [lon, lat]) {
  const [west, south, east, north] = bounds;
  return [(lon - west) / (east - west) * width, (north - lat) / (north - south) * height];
}

export function outlookButton(parent, onToggle) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Outlook map';
  button.setAttribute('aria-pressed', 'false');
  parent.append(button);
  button.onclick = () => onToggle(button.getAttribute('aria-pressed') !== 'true');
  return button;
}

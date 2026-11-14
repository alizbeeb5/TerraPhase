/* Shared rectangular selection. Preserves the drawn rectangle; Escape cancels. */
window.attachAreaSelection = function(map, {onSelect, onHint}) {
  const element=map.getContainer();let enabled=false,start=null,rectangle=null,ignoreClickUntil=0;
  function clear(){start=null;if(rectangle){map.removeLayer(rectangle);rectangle=null;}}
  function enable(value){enabled=value;clear();element.classList.toggle('select-box-cursor',value);if(value)map.dragging.disable();else map.dragging.enable();}
  function point(event){const box=element.getBoundingClientRect();return map.containerPointToLatLng(L.point(event.clientX-box.left,event.clientY-box.top));}
  element.addEventListener('pointerdown',event=>{
    if(!enabled||event.button!==0||event.target.closest('.leaflet-control'))return;
    event.preventDefault();event.stopPropagation();start=point(event);element.setPointerCapture(event.pointerId);
  },true);
  element.addEventListener('pointermove',event=>{
    if(!enabled||!start)return;
    const bounds=L.latLngBounds(start,point(event));
    if(rectangle)rectangle.setBounds(bounds);else rectangle=L.rectangle(bounds,{color:'#22c55e',weight:2,dashArray:'6 4',fillOpacity:.12,interactive:false}).addTo(map);
  });
  element.addEventListener('pointerup',event=>{
    if(!enabled||!start)return;
    event.preventDefault();const end=point(event),begin=start;
    const a=map.latLngToContainerPoint(begin),b=map.latLngToContainerPoint(end);
    clear();ignoreClickUntil=Date.now()+400;try{element.releasePointerCapture(event.pointerId);}catch(_){}
    if(Math.abs(a.x-b.x)<4||Math.abs(a.y-b.y)<4){onHint('Draw a rectangle with some width and height.');return;}
    const bounds=L.latLngBounds(begin,end);enable(false);
    onSelect([bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()]);
  });
  for(const name of ['pointercancel','lostpointercapture'])element.addEventListener(name,clear);
  element.addEventListener('click',event=>{if(!event.target.closest('.leaflet-control')&&(enabled||Date.now()<ignoreClickUntil)){event.preventDefault();event.stopImmediatePropagation();}},true);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&enabled){enable(false);onHint('Selection cancelled. Pan the map or select another area.');}});
  return {enable,get enabled(){return enabled;}};
};

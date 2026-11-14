'use strict';
const worldUI=Object.fromEntries([...document.querySelectorAll('[id]')].map(element=>[element.id,element]));
const worldMap=L.map('world-map',{zoomControl:false,minZoom:2,maxZoom:18,zoomSnap:.25,worldCopyJump:false}).setView([15,-20],2);
worldMap.createPane('world-base');worldMap.getPane('world-base').style.zIndex=150;
fetch('/assets/world-land.geojson').then(response=>response.json()).then(data=>L.geoJSON(data,{pane:'world-base',interactive:false,style:{color:'#5a7a74',weight:.7,fillColor:'#385b4e',fillOpacity:1},attribution:'<a href="https://www.naturalearthdata.com/">Natural Earth</a>'}).addTo(worldMap)).catch(()=>{});
L.control.zoom({position:'topleft'}).addTo(worldMap);
L.control.scale({imperial:false,position:'bottomleft'}).addTo(worldMap);
const availability=[];let navigationVersion=0;
const basemap=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:18,noWrap:true,attribution:'Tiles © Esri — Esri, Maxar, Earthstar Geographics, USGS'}).addTo(worldMap);
L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',{maxZoom:18,noWrap:true,pane:'overlayPane',attribution:'Place labels © Esri'}).addTo(worldMap);
function status(text,error=false){worldUI['app-status'].textContent=text;worldUI['app-status'].dataset.error=String(error);worldUI['map-hint-pill'].textContent=text;}
function escapeText(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function worldJSON(url){const response=await fetch(url);let data;try{data=await response.json();}catch(_){throw Error('The image server returned an unreadable response.');}if(!response.ok)throw Error(data.detail||'The image server could not complete this request.');return data;}
function boundsOf(feature){const [w,s,e,n]=feature.properties.bounds_wgs84;return L.latLngBounds([s,w],[n,e]);}
function coordinates(bounds){['west','south','east','north'].forEach((key,i)=>worldUI[`area-${key}`].value=bounds[i].toFixed(6));}
function dateOf(feature){return(feature.properties.acquired_at||'').split('T')[0];}
function destination(feature,bbox){const query=new URLSearchParams({scene:feature.properties.id});if(bbox)query.set('bbox',bbox.join(','));return `/explorer/?${query}`;}
function openFootprint(feature){window.location.assign(destination(feature));}
async function selectWorldArea(bounds){
  const version=++navigationVersion;
  const candidates=availability.filter(feature=>{const b=feature.properties.bounds_wgs84;return bounds[0]<b[2]&&bounds[2]>b[0]&&bounds[1]<b[3]&&bounds[3]>b[1];});
  if(!candidates.length){status('No downloaded NISAR image covers that area. Select inside the blue footprint.',true);return;}
  status('Checking data in your selection…');
  for(const feature of candidates){
    try{
      const metadata=await worldJSON(feature.properties.metadata_url);
      const layer=metadata.layers.frequencyA_HHHH||Object.values(metadata.layers)[0];
      const url=layer.urls.tilejson.replace('/tilejson.json','/region')+'?'+new URLSearchParams({bbox:bounds.join(',')});
      const region=await worldJSON(url);if(version!==navigationVersion)return;
      window.location.assign(destination(feature,region.bbox));return;
    }catch(error){if(version!==navigationVersion)return;if(candidates.length===1){status(error.message,true);return;}}
  }
  status('No usable backscatter was found in that area. Select inside the downloaded scene.',true);
}
const worldSelection=attachAreaSelection(worldMap,{onSelect:bounds=>{worldUI['tool-box'].classList.remove('active');worldUI['tool-pan'].classList.add('active');coordinates(bounds);selectWorldArea(bounds);},onHint:status});
function setTool(box){worldSelection.enable(box);worldUI['tool-box'].classList.toggle('active',box);worldUI['tool-pan'].classList.toggle('active',!box);status(box?'Drag a rectangle inside the blue NISAR footprint. Escape cancels.':'Click a blue footprint to open its image.');}
worldUI['tool-pan'].addEventListener('click',()=>setTool(false));
worldUI['tool-box'].addEventListener('click',()=>setTool(!worldSelection.enabled));
worldUI['tool-zoom-in'].addEventListener('click',()=>worldMap.zoomIn());
worldUI['tool-zoom-out'].addEventListener('click',()=>worldMap.zoomOut());
worldUI['btn-available'].addEventListener('click',()=>{
  if(!availability.length)return;setTool(false);const all=L.latLngBounds(availability.flatMap(feature=>[boundsOf(feature).getSouthWest(),boundsOf(feature).getNorthEast()]));worldMap.fitBounds(all,{padding:[35,35],animate:false});coordinates(availability[0].properties.bounds_wgs84);
});
worldUI['selection-form'].addEventListener('submit',event=>{event.preventDefault();selectWorldArea(['west','south','east','north'].map(key=>Number(worldUI[`area-${key}`].value)));});
worldMap.on('click',event=>{if(worldSelection.enabled)return;const scene=availability.find(feature=>boundsOf(feature).contains(event.latlng));if(scene)openFootprint(scene);else status('No downloaded NISAR image at this location. Choose the blue footprint.',true);});
basemap.on('tileerror',()=>{if(!availability.length)return;worldUI['map-hint-pill'].textContent='Background map unavailable. The NISAR footprint and image still work.';});

(async()=>{
  try{
    const catalog=await worldJSON('/api/scenes');availability.push(...catalog.features);
    for(const feature of availability){
      const rectangle=L.rectangle(boundsOf(feature),{color:'#258dff',weight:2,fillColor:'#258dff',fillOpacity:.2,className:'scene-footprint'}).addTo(worldMap);
      rectangle.bindTooltip(`NISAR GCOV · ${dateOf(feature)} · click to open`);
      rectangle.on('click',event=>{if(worldSelection.enabled)return;L.DomEvent.stopPropagation(event);openFootprint(feature);});
      const element=rectangle.getElement();element.setAttribute('role','button');element.setAttribute('aria-label',`Open NISAR image acquired ${dateOf(feature)}`);element.setAttribute('tabindex','0');element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openFootprint(feature);}});
    }
    const panel=worldUI['side-panel-content'];
    panel.innerHTML='<div class="panel-header"><h2 class="panel-area-name">Available NISAR imagery</h2><p class="panel-coords">'+availability.length+' downloaded scene'+(availability.length===1?'':'s')+'</p></div><div class="panel-block"><p>Choose a footprint on the world map to open the explorer with actual GCOV backscatter.</p><div class="scene-list" id="downloaded-scenes"></div></div><div class="panel-block"><h3 class="panel-block-title">One connected workflow</h3><ul class="bullet-list"><li>Click a blue rectangle to inspect the whole scene.</li><li>Use Select box to inspect only the rectangle you draw.</li><li>In the explorer, pan and zoom, switch HH/HV, inspect terrain, and export evidence.</li></ul></div><div class="panel-block"><h3 class="panel-block-title">Data availability</h3><p>These footprints represent files downloaded to this server. They are not a map of all NISAR acquisitions worldwide.</p><p class="small-note">Your friend’s observed case and radar lab remain available in the explorer. They are labeled separately from your NISAR scene.</p></div>';
    for(const feature of availability){const button=document.createElement('button');button.type='button';button.className='scene-open';button.textContent=`Open NISAR scene · ${dateOf(feature)}`;const span=document.createElement('span');span.textContent='Real GCOV · HH and HV · 10 m grid';button.append(span);button.addEventListener('click',()=>openFootprint(feature));document.getElementById('downloaded-scenes').append(button);}
    status(availability.length?'Click the blue NISAR footprint, or Find available image to zoom to it.':'No NISAR files have been prepared on this server yet.');
    if(availability[0])coordinates(availability[0].properties.bounds_wgs84);
  }catch(error){status(error.message,true);}
})();

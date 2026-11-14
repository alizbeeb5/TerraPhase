'use strict';

// The displayed image is always an XYZ tile layer. No preview PNG is enlarged.
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
const map = L.map('map', {zoomControl:false, minZoom:2, maxZoom:22, zoomSnap:0.25, worldCopyJump:false}).setView([9,-79.5],7);
L.control.zoom({position:'topright'}).addTo(map);
L.control.scale({position:'bottomleft',imperial:false,maxWidth:130}).addTo(map);
map.createPane('basemap'); map.getPane('basemap').style.zIndex = 190;
let scene = null, activeLayer = null, activeRaster = null, activeInfo = null, footprint = null;
let generation = 0, tileErrors = 0;
const streetMap = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  pane:'basemap', maxZoom:22, maxNativeZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
});
streetMap.on('tileerror', () => { if(ui['basemap-toggle'].checked) setStatus('Street map unavailable. Your GCOV image is still available.'); });

function setStatus(message, error=false){ui.status.textContent=message;ui.status.dataset.error=String(error);}
function message(text){ui['map-message'].textContent=text;ui['map-message'].hidden=!text;}
async function json(url){const response=await fetch(url);if(!response.ok)throw new Error(`The image server returned ${response.status}.`);return response.json();}
function sceneBounds(layer){const [w,s,e,n]=layer.bounds_wgs84;return L.latLngBounds([s,w],[n,e]);}
function fitImage(){if(activeLayer)map.fitBounds(sceneBounds(activeLayer),{padding:[30,30],animate:false});}
function formatDate(value){if(!value)return 'Acquisition time unavailable';const date=new Date(value.endsWith('Z')?value:`${value}Z`);return `${date.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'})} · ${date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'UTC'})} UTC`;}
function updatePosition(){const center=map.getCenter();ui.position.textContent=`${center.lat.toFixed(4)}°, ${center.lng.toFixed(4)}° · Zoom ${map.getZoom()}`;if(activeLayer&&map.getZoom()>activeLayer.native_zoom)setStatus(`Native ${activeLayer.pixel_spacing_m[0]} m samples · further zoom enlarges existing pixels.`);}
function updateLegend(layer){const {vmin,vmax}=layer.display;ui['legend-title'].textContent=`${layer.polarization.slice(0,2)} backscatter`;ui['legend-min'].textContent=vmin.toFixed(1);ui['legend-mid'].textContent=((vmin+vmax)/2).toFixed(1);ui['legend-max'].textContent=vmax.toFixed(1);ui.legend.hidden=false;}

async function selectLayer(key, fit=false){
  const version=++generation;
  const layer=scene.layers[key];
  if(!layer)return;
  setStatus('Loading image detail…');ui.retry.hidden=true;
  try{
    const tileMetadataUrl=new URL(layer.urls.tilejson);tileMetadataUrl.searchParams.set('cmap','gray');
    const info=await json(tileMetadataUrl);
    if(version!==generation)return;
    const raster=L.tileLayer(info.tiles[0],{
      tileSize:256, minZoom:0, maxZoom:22, maxNativeZoom:info.native_zoom,
      bounds:sceneBounds(layer), noWrap:true, keepBuffer:2, updateWhenIdle:true,
      attribution:info.attribution
    });
    tileErrors=0;
    raster.on('loading',()=>{if(version===generation)setStatus('Loading image detail…');});
    raster.on('tileerror',()=>{if(version===generation){tileErrors++;setStatus('Some image tiles could not load. Use “Try loading again” to retry.',true);ui.retry.hidden=false;}});
    raster.on('load',()=>{if(version!==generation)return;if(!tileErrors){setStatus(`Image ready · ${layer.pixel_spacing_m[0]} m native grid. Scroll to zoom or drag to pan.`);message('');}updatePosition();});
    if(activeRaster)map.removeLayer(activeRaster);
    activeLayer=layer;activeRaster=raster;activeInfo=info;raster.addTo(map);
    for(const button of ui['layer-buttons'].querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.layer===key));
    ui['pixel-spacing'].textContent=`${layer.pixel_spacing_m[0]} m`;
    ui['image-size'].textContent=`${layer.width.toLocaleString()} × ${layer.height.toLocaleString()}`;
    ui['layer-description'].textContent=`${layer.polarization.slice(0,2)} polarization · gamma0 backscatter`;
    ui['view-label'].textContent=`${layer.polarization.slice(0,2)} · ${layer.pixel_spacing_m[0]} m grid`;
    ui['download-image'].href=layer.urls.download;ui['download-image'].hidden=false;
    ui['fit-image'].disabled=false;ui['full-detail'].disabled=false;
    updateLegend(layer);if(fit)fitImage();updatePosition();
  }catch(error){if(version!==generation)return;setStatus(`${error.message} Try loading again.`,true);ui.retry.hidden=false;if(!activeRaster)message('The image could not be opened. Check that the local image server is running, then try again.');}
}

async function selectScene(url){
  const version=++generation;
  setStatus('Opening your scene…');
  try{
    const loaded=await json(url);if(version!==generation)return;scene=loaded;
    ui.acquisition.textContent=formatDate(scene.identification.zeroDopplerStartTime);
    ui['layer-buttons'].replaceChildren();
    for(const [key,layer] of Object.entries(scene.layers)){
      const button=document.createElement('button');button.type='button';button.dataset.layer=key;
      button.textContent=layer.polarization.slice(0,2);button.setAttribute('aria-label',`Show ${layer.polarization.slice(0,2)} image`);button.setAttribute('aria-pressed','false');button.addEventListener('click',()=>selectLayer(key));ui['layer-buttons'].append(button);
    }
    await selectLayer(scene.layers.frequencyA_HHHH?'frequencyA_HHHH':Object.keys(scene.layers)[0],true);
  }catch(error){if(version===generation){setStatus('Could not open the scene. Try loading again.',true);ui.retry.hidden=false;message(error.message);}}
}

async function initialize(){
  ui.retry.hidden=true;
  try{
    const catalog=await json('/api/scenes');
    if(!catalog.features.length){setStatus('No images have been prepared yet.');message('No GCOV images are available yet. Prepare a GCOV file, then refresh this page.');return;}
    ui['scene-select'].replaceChildren();
    for(const [index,feature] of catalog.features.entries()){
      const option=document.createElement('option');option.value=feature.properties.metadata_url;option.textContent=`Scene ${index+1} · ${formatDate(feature.properties.acquired_at).split(' · ')[0]}`;ui['scene-select'].append(option);
    }
    ui['scene-select'].disabled=false;
    if(footprint)map.removeLayer(footprint);
    footprint=L.geoJSON(catalog,{style:{color:'#38c7c1',weight:2,fillOpacity:0},onEachFeature(feature,polygon){polygon.bindTooltip('Click to open this GCOV scene');polygon.on('click',()=>{ui['scene-select'].value=feature.properties.metadata_url;selectScene(feature.properties.metadata_url);});}});
    if(ui['footprint-toggle'].checked)footprint.addTo(map);
    await selectScene(ui['scene-select'].value);
  }catch(error){setStatus('Could not connect to the image server. Try loading again.',true);message(error.message);ui.retry.hidden=false;}
}

ui['fit-image'].addEventListener('click',fitImage);
ui['full-detail'].addEventListener('click',()=>{if(!activeLayer)return;const bounds=sceneBounds(activeLayer);map.setView(bounds.contains(map.getCenter())?map.getCenter():bounds.getCenter(),activeLayer.native_zoom,{animate:false});});
ui['world-view'].addEventListener('click',()=>map.setView([15,0],2,{animate:false}));
ui['scene-select'].addEventListener('change',()=>selectScene(ui['scene-select'].value));
ui['basemap-toggle'].addEventListener('change',()=>{if(ui['basemap-toggle'].checked)streetMap.addTo(map);else map.removeLayer(streetMap);});
ui['footprint-toggle'].addEventListener('change',()=>{if(!footprint)return;if(ui['footprint-toggle'].checked)footprint.addTo(map);else map.removeLayer(footprint);});
ui.retry.addEventListener('click',()=>scene&&activeLayer?selectLayer(activeLayer.id):initialize());
map.on('moveend zoomend',updatePosition);
window.addEventListener('resize',()=>map.invalidateSize());
initialize();

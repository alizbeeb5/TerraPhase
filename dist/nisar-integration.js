/* Real NISAR adapter for the shared main explorer. Reference case/lab stay intact. */
'use strict';
(() => {
  const N={scene:null,layer:null,bbox:null,region:null,map:null,raster:null,slopeOverlay:null,dem:null,demKey:null,texture:null,three:null,loading:false,version:0,layerVersion:0,terrainVersion:0,lastSlope:false};
  const params=new URLSearchParams(location.search);
  const sceneId=params.get('scene');
  let requestedBox=params.get('bbox');
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const geoBounds=box=>L.latLngBounds([box[1],box[0]],[box[3],box[2]]);
  const api=(name,extra={})=>N.layer.urls.tilejson.replace('/tilejson.json','/'+name)+'?'+new URLSearchParams({bbox:N.bbox.join(','),...extra});
  async function json(url){const response=await fetch(url);const data=await response.json();if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:'This data request could not be completed.');return data;}
  function notice(text,error=false){$('nisar-notice').textContent=text;$('nisar-notice').classList.toggle('nisar-error',error);}
  function error(text){$('map-error').textContent=text;$('map-error').hidden=false;notice(text,true);}

  const nativeMap=document.createElement('div');nativeMap.id='nisar-map';nativeMap.hidden=true;$('image-area').prepend(nativeMap);
  const controls=document.createElement('div');controls.className='nisar-controls';controls.id='nisar-controls';controls.hidden=true;
  controls.append(button('Fit image',()=>fit()),button('Full detail',()=>detail()),button('Select area',()=>select()),button('Whole scene',()=>location.assign('/explorer/?'+new URLSearchParams({scene:N.scene.id}))));
  document.querySelector('.timeline').after(controls);
  const status=document.createElement('p');status.id='nisar-notice';status.className='nisar-notice';status.hidden=true;controls.after(status);
  const surface=document.createElement('div');surface.id='nisar-terrain';surface.hidden=true;$('terrain-canvas').after(surface);
  const terrainNote=document.createElement('p');terrainNote.className='nisar-terrain-note';terrainNote.hidden=true;surface.after(terrainNote);
  const dataLink=document.createElement('a');dataLink.id='nisar-download';dataLink.className='nisar-download';dataLink.textContent='Download image';dataLink.hidden=true;document.querySelector('.evidence-foot').append(dataLink);
  const method=document.createElement('section');method.innerHTML='<h3>Your NISAR scene</h3><p>The selected scene is actual NISAR Level-2 GCOV gamma0 power. Display values use 10 log10(power), with a common scale for tiles and the legend. Native samples are preserved at their supplied grid spacing. A selection clips the existing measurements; it does not generate a new simulated scene.</p><p>Only one NISAR acquisition is available here, so change alerts, optical comparison and forest-loss totals are not calculated for this scene. The observed reference case and educational lab remain separate modes.</p><p>The NISAR 3D view samples real Mapzen Terrain Tiles (or a configured local DEM) over the same Web Mercator extent as its radar texture. Elevation/bathymetry is in metres. Exaggeration multiplies actual relative height. The mesh and texture are sampled overviews; use the 2D map to inspect native radar detail. No procedural elevation is substituted if the DEM is unavailable.</p><p><a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles dataset</a> · <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">DEM attribution</a></p>';$('method-content').prepend(method);

  function ensureMap(){
    if(N.map)return;
    N.map=L.map(nativeMap,{zoomControl:false,minZoom:2,maxZoom:22,zoomSnap:.25});
    L.control.zoom({position:'topright'}).addTo(N.map);L.control.scale({position:'bottomleft',imperial:false}).addTo(N.map);
    N.selection=attachAreaSelection(N.map,{onSelect:async bounds=>{
      notice('Checking data in the selected rectangle…');
      try{const info=await json(api('region',{bbox:bounds.join(',')}));location.assign('/explorer/?'+new URLSearchParams({scene:N.scene.id,bbox:info.bbox.join(',')}));}catch(e){notice(e.message,true);}
    },onHint:notice});
    N.map.on('moveend zoomend',()=>{if(state.mode==='nisar'&&N.layer&&N.map.getZoom()>N.layer.native_zoom)notice('At native grid detail. Further zoom enlarges existing samples.');});
  }
  function fit(){if(N.map&&N.bbox)N.map.fitBounds(geoBounds(N.bbox),{padding:[24,24],animate:false,maxZoom:N.layer.native_zoom});}
  function detail(){if(!N.map||!N.bbox)return;const bounds=geoBounds(N.bbox);N.map.setView(bounds.contains(N.map.getCenter())?N.map.getCenter():bounds.getCenter(),N.layer.native_zoom,{animate:false});}
  function select(){if(!N.selection)return;N.selection.enable(!N.selection.enabled);notice(N.selection.enabled?'Drag a rectangle in the image. Escape cancels.':'Selection cancelled.');}

  async function applyLayer(fitView=false){
    if(!N.scene)return;
    const version=++N.layerVersion;
    N.layer=N.scene.layers['frequencyA_'+(state.view==='hv'?'HVHV':'HHHH')]||Object.values(N.scene.layers).find(layer=>layer.polarization.startsWith(state.view.toUpperCase()))||Object.values(N.scene.layers)[0];
    const layer=N.layer;
    updateNativeUI();notice('Loading actual GCOV image tiles…');
    try{
      const query=new URL(layer.urls.tilejson);query.searchParams.set('cmap','gray');if(N.region)query.searchParams.set('bbox',N.bbox.join(','));
      const info=await json(query);if(version!==N.layerVersion||state.mode!=='nisar')return;
      const tiles=L.tileLayer(info.tiles[0],{bounds:geoBounds(N.bbox),tileSize:256,maxNativeZoom:layer.native_zoom,maxZoom:22,noWrap:true,keepBuffer:2,attribution:info.attribution});
      let failed=false;
      tiles.on('loading',()=>{if(version===N.layerVersion&&state.mode==='nisar')notice('Loading image detail…');});
      tiles.on('tileerror',()=>{if(version===N.layerVersion){failed=true;notice('Some image tiles could not load. Switch layers to retry.',true);}});
      tiles.on('load',()=>{if(version!==N.layerVersion||state.mode!=='nisar')return;if(!failed){$('map-error').hidden=true;notice(N.map.getZoom()>layer.native_zoom?'Native samples shown; further zoom enlarges existing pixels.':'Actual GCOV data ready. Scroll to zoom or drag to pan.');}});
      if(N.raster)N.map.removeLayer(N.raster);N.raster=tiles;tiles.addTo(N.map);
      if(fitView)fit();
      N.texture=null;N.terrainVersion++;
      if(state.slope)await updateSlope();
      if($('terrain').open)loadTerrain();
    }catch(e){if(version===N.layerVersion)error(e.message);}
  }

  function updateNativeUI(){
    if(state.mode!=='nisar')return;
    document.body.classList.add('is-nisar');nativeMap.hidden=false;canvas.hidden=true;controls.hidden=false;status.hidden=false;
    ['swipe','divider','after-label','markers'].forEach(id=>$(id).hidden=true);
    $('before-label').hidden=false;$('scale').hidden=true;$('zoom').hidden=false;$('zoom').textContent='Full detail';
    $('zoom').disabled=!N.layer;controls.querySelectorAll('button').forEach(control=>control.disabled=!N.layer);
    $('terrain-canvas').hidden=true;surface.hidden=false;terrainNote.hidden=false;
    document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode==='nisar')));
    $('heading').textContent='Your radar data, in focus.';$('subhead').textContent='Explore your downloaded NISAR image, select an area, and inspect real terrain context.';
    $('dataset-status').classList.remove('simulated');$('dataset-status').innerHTML='<span></span> Actual NISAR GCOV';
    $('site-title').textContent=N.region?'Selected NISAR area':'NISAR scene · Panama';
    $('evidence-title').textContent='Inspect your scene';$('evidence-sub').textContent=N.region?'Your selected rectangle':'Whole downloaded scene';
    $('image-area').style.aspectRatio='auto';
    $('date-range').disabled=true;$('date-range').max=0;$('date-range').value=0;$('play').disabled=true;
    $('time-title').textContent='ONE NISAR ACQUISITION';$('ticks').replaceChildren();
    $('orbit').hidden=!N.layer;$('download').hidden=!N.layer;$('slope').disabled=!N.layer;$('slope').checked=state.slope;
    if(!N.scene||!N.layer){$('date').textContent='Loading…';return;}
    const layer=N.layer,acquired=N.scene.identification.zeroDopplerStartTime,date=acquired.split('T')[0];
    $('date').textContent=shortDate(date);$('before-label').textContent=`${state.view.toUpperCase()} · ${date} · ${layer.pixel_spacing_m[0]} m grid`;
    if($('view-buttons').dataset.mode!=='nisar'){
      $('view-buttons').dataset.mode='nisar';$('view-buttons').replaceChildren(...[['hh','HH'],['hv','HV']].map(([key,name])=>{const b=button(name,()=>{state.view=key;applyLayer();},false);b.dataset.view=key;return b;}));
      const unavailable=button('Change',()=>{},false);unavailable.disabled=true;unavailable.title='Change detection needs another compatible NISAR acquisition';$('view-buttons').append(unavailable);
    }
    [...$('view-buttons').children].forEach(b=>{if(b.dataset.view)b.setAttribute('aria-pressed',String(b.dataset.view===state.view));});
    const {vmin,vmax}=layer.display;
    $('legend').innerHTML=`<strong>${escape(state.view.toUpperCase())} gamma0 · dB</strong><div class="nisar-legend-bar"></div><div class="nisar-legend-values"><span>${vmin.toFixed(1)}</span><span>${((vmin+vmax)/2).toFixed(1)}</span><span>${vmax.toFixed(1)}</span></div>${state.slope?'<span><i class="swatch purple"></i>DEM slope &gt;25°</span>':''}`;
    $('patch-list').replaceChildren();
    const width=N.region?.native_width||layer.width,height=N.region?.native_height||layer.height;
    $('evidence-body').innerHTML='<div class="metrics">'+metric(layer.pixel_spacing_m[0]+' m','Native radar grid')+metric(number(width,0)+' × '+number(height,0),'Native pixels in extent')+'</div><div class="facts"><p><strong>Acquisition.</strong> '+escape(acquired.replace('T',' ').split('.')[0])+' UTC.</p><p><strong>Backscatter.</strong> Actual '+escape(state.view.toUpperCase())+' gamma0 power, displayed as 10 log10(power). Darker values represent weaker radar return.</p><p><strong>Coverage.</strong> '+(N.region?'Clipped to your selected rectangle; original grid values are preserved.':'The whole local scene is available. Only downloaded coverage is shown on the world map.')+'</p><p><strong>Change analysis.</strong> One NISAR acquisition is available. Forest-loss totals and temporal alerts are not calculated for this scene.</p><p><strong>Terrain.</strong> '+(N.dem?escape(N.dem.source.name)+': '+number(N.dem.min_elevation_m,0)+' to '+number(N.dem.max_elevation_m,0)+' m.':'Open 3D terrain or enable slopes to load real elevation data for this same area.')+'</p></div><div class="nisar-downloads"><a class="nisar-download" href="'+escape(layer.urls.download)+'">Whole-scene GeoTIFF</a>'+(N.region&&N.region.crop_download_available?'<a class="nisar-download" href="'+escape(api('crop.tif'))+'">Selected-area GeoTIFF</a>':'')+'</div><p class="nisar-source-name">'+escape(N.scene.source_filename)+'</p>';
    dataLink.hidden=false;dataLink.href=N.region&&N.region.crop_download_available?api('crop.tif'):layer.urls.download;
    $('attribution').textContent='NASA / ISRO NISAR'+(N.dem?' · '+N.dem.source.attribution:'');
  }

  async function enter(){
    state.mode='nisar';state.view=['hh','hv'].includes(state.view)?state.view:'hh';state.step=0;revision++;
    ensureMap();updateNativeUI();N.map.invalidateSize();
    if(N.scene){applyLayer(true);return;}
    if(N.loading)return;N.loading=true;const version=++N.version;notice('Opening the selected NISAR scene…');
    try{
      const catalog=await json('/api/scenes');const feature=catalog.features.find(f=>f.properties.id===sceneId)||(!sceneId?catalog.features[0]:null);
      if(!feature)throw Error('That NISAR scene is not available. Return to the world map and select a downloaded footprint.');
      const scene=await json(feature.properties.metadata_url);if(version!==N.version)return;
      const layer=scene.layers.frequencyA_HHHH||Object.values(scene.layers)[0];
      const region=requestedBox?await json(layer.urls.tilejson.replace('/tilejson.json','/region')+'?'+new URLSearchParams({bbox:requestedBox})):null;
      N.scene=scene;N.layer=layer;N.region=region;N.bbox=region?region.bbox:layer.bounds_wgs84;
      const url=new URL(location);url.searchParams.set('scene',scene.id);url.searchParams.delete('mode');history.replaceState(null,'',url);
      updateNativeUI();N.map.invalidateSize();await applyLayer(true);
    }catch(e){error(e.message);}finally{N.loading=false;}
  }
  function leave(){N.layerVersion++;N.terrainVersion++;if(N.slopeOverlay){N.map.removeLayer(N.slopeOverlay);N.slopeOverlay=null;}N.lastSlope=false;document.body.classList.remove('is-nisar');nativeMap.hidden=true;canvas.hidden=false;controls.hidden=true;status.hidden=true;surface.hidden=true;terrainNote.hidden=true;$('terrain-canvas').hidden=false;dataLink.hidden=true;$('markers').hidden=false;$('zoom').disabled=false;}

  async function getDem(){
    const key=N.bbox.join(',');if(N.dem&&N.demKey===key)return N.dem;
    if(N.demPending&&N.demPendingKey===key)return N.demPending;
    N.demPendingKey=key;
    const pending=json(api('terrain',{grid:129})).then(dem=>{N.dem=dem;N.demKey=key;return dem;});
    N.demPending=pending;
    try{return await pending;}finally{if(N.demPending===pending)N.demPending=null;}
  }
  function slopeCanvas(dem,size=512){
    const image=document.createElement('canvas');image.width=size;image.height=size;const ctx=image.getContext('2d'),data=ctx.createImageData(size,size),cols=dem.columns,rows=dem.rows;
    for(let row=0;row<size;row++)for(let col=0;col<size;col++){
      const u=(col+.5)/size*(cols-1),v=(row+.5)/size*(rows-1),x=Math.floor(u),y=Math.floor(v),dx=u-x,dy=v-y;
      const value=(dem.slope_degrees[y*cols+x]*(1-dx)+dem.slope_degrees[y*cols+Math.min(x+1,cols-1)]*dx)*(1-dy)+(dem.slope_degrees[Math.min(y+1,rows-1)*cols+x]*(1-dx)+dem.slope_degrees[Math.min(y+1,rows-1)*cols+Math.min(x+1,cols-1)]*dx)*dy;
      if(value>25)data.data.set([206,148,255,125],(row*size+col)*4);
    }
    ctx.putImageData(data,0,0);return image;
  }
  async function updateSlope(){
    if(N.slopeOverlay){N.map.removeLayer(N.slopeOverlay);N.slopeOverlay=null;}
    if(!state.slope){if(N.three)refreshTerrainTexture();return;}
    notice('Loading real DEM slopes…');
    try{const dem=await getDem();if(state.mode!=='nisar'||!state.slope)return;N.slopeOverlay=L.imageOverlay(slopeCanvas(dem).toDataURL(),geoBounds(N.bbox),{interactive:false,opacity:1}).addTo(N.map);updateNativeUI();if(N.three)refreshTerrainTexture();notice('DEM slope overlay loaded. Slope alone is not a radar layover or shadow mask.');}catch(e){state.slope=false;updateNativeUI();notice(e.message,true);}
  }

  function busy(text,retry=false){let box=surface.querySelector('.nisar-terrain-status');if(!box){box=document.createElement('div');box.className='nisar-terrain-status';surface.append(box);}box.replaceChildren(document.createTextNode(text));if(retry)box.append(button('Retry terrain',()=>loadTerrain()));}
  async function imageFromURL(url){const response=await fetch(url);if(!response.ok){const error=await response.json();throw Error(error.detail||'The radar texture could not load.');}const object=URL.createObjectURL(await response.blob());try{return await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(Error('The image texture could not be decoded.'));image.src=object;});}finally{URL.revokeObjectURL(object);}}
  function ensureThree(){
    if(N.three)return;
    const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.setClearColor(0x0b120f);renderer.outputEncoding=THREE.sRGBEncoding;
    surface.prepend(renderer.domElement);const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(42,1,.01,100);
    N.three={renderer,scene,camera,mesh:null,texture:null,elevation:.67,distance:4,drag:null};
    const element=renderer.domElement;
    element.addEventListener('pointerdown',e=>{if(e.button!==0)return;N.three.drag=[e.clientX,e.clientY];element.setPointerCapture(e.pointerId);});
    element.addEventListener('pointermove',e=>{const t=N.three;if(!t.drag)return;const dx=e.clientX-t.drag[0],dy=e.clientY-t.drag[1];$('angle').value=((Number($('angle').value)-dx*.45+540)%360)-180;t.elevation=Math.max(.15,Math.min(1.5,t.elevation+dy*.007));t.drag=[e.clientX,e.clientY];renderThree();});
    for(const name of ['pointerup','pointercancel','lostpointercapture'])element.addEventListener(name,()=>N.three.drag=null);
    element.addEventListener('wheel',e=>{e.preventDefault();N.three.distance=Math.max(1.2,Math.min(9,N.three.distance*Math.exp(e.deltaY*.001)));renderThree();},{passive:false});
  }
  function refreshTerrainTexture(){
    const t=N.three;if(!t?.mesh||!N.texture)return;
    const combined=document.createElement('canvas');combined.width=N.texture.width;combined.height=N.texture.height;const ctx=combined.getContext('2d');ctx.drawImage(N.texture,0,0);
    if(state.slope&&N.dem)ctx.drawImage(slopeCanvas(N.dem),0,0,combined.width,combined.height);
    const texture=new THREE.CanvasTexture(combined);texture.encoding=THREE.sRGBEncoding;texture.magFilter=THREE.NearestFilter;texture.minFilter=THREE.LinearFilter;
    t.texture?.dispose();t.texture=texture;t.mesh.material.map=texture;t.mesh.material.needsUpdate=true;renderThree();
  }
  async function loadTerrain(){
    if(!N.scene||!$('terrain').open||state.mode!=='nisar')return;
    const requestKey=N.bbox.join(',')+N.layer.id;
    if(N.terrainLoadingKey===requestKey)return;
    N.terrainLoadingKey=requestKey;
    const version=++N.terrainVersion;busy('Loading real elevation data and your radar image…');
    try{
      const [dem,image]=await Promise.all([getDem(),imageFromURL(api('texture.png',{size:2048,cmap:'gray'}))]);
      if(version!==N.terrainVersion||state.mode!=='nisar'||!$('terrain').open)return;
      ensureThree();const t=N.three,scale=2.6/Math.max(dem.width_m,dem.height_m);
      if(t.mesh){t.scene.remove(t.mesh);t.mesh.geometry.dispose();t.mesh.material.dispose();}
      const geometry=new THREE.PlaneGeometry(dem.width_m*scale,dem.height_m*scale,dem.columns-1,dem.rows-1);
      const material=new THREE.MeshBasicMaterial({side:THREE.DoubleSide,transparent:true,alphaTest:.01});
      t.mesh=new THREE.Mesh(geometry,material);t.mesh.rotation.x=-Math.PI/2;t.scene.add(t.mesh);t.dem=dem;t.scale=scale;N.texture=image;
      refreshTerrainTexture();updateGeometry();surface.querySelector('.nisar-terrain-status')?.remove();
      terrainNote.textContent=`${dem.source.name}: ${number(dem.min_elevation_m,0)}–${number(dem.max_elevation_m,0)} m elevation/bathymetry. This is a sampled 3D overview; inspect native radar detail in the 2D map.`;
      updateNativeUI();renderThree();
    }catch(e){if(version===N.terrainVersion)busy(e.message,true);}finally{if(N.terrainLoadingKey===requestKey)N.terrainLoadingKey=null;}
  }
  function updateGeometry(){const t=N.three;if(!t?.mesh)return;const positions=t.mesh.geometry.attributes.position,exaggeration=Number($('exag').value);for(let i=0;i<t.dem.elevation_m.length;i++)positions.setZ(i,(t.dem.elevation_m[i]-t.dem.min_elevation_m)*t.scale*exaggeration);positions.needsUpdate=true;t.mesh.geometry.computeBoundingSphere();}
  function renderThree(){const t=N.three;if(!t?.mesh||!$('terrain').open||state.mode!=='nisar')return;const width=surface.clientWidth||680,height=surface.clientHeight||390;t.renderer.setSize(width,height,false);t.camera.aspect=width/height;t.camera.updateProjectionMatrix();const angle=Number($('angle').value)*Math.PI/180,d=t.distance;t.camera.position.set(d*Math.cos(t.elevation)*Math.sin(angle),d*Math.sin(t.elevation),d*Math.cos(t.elevation)*Math.cos(angle));t.camera.lookAt(0,(t.dem.max_elevation_m-t.dem.min_elevation_m)*t.scale*Number($('exag').value)*.35,0);t.renderer.render(t.scene,t.camera);}
  function drawTerrainReal(){if(!N.three?.mesh||!N.texture){loadTerrain();return;}updateGeometry();renderThree();}
  function exportEvidence(){if(!N.scene)return;const evidence={type:'single-acquisition GCOV inspection',scene:N.scene.id,source:N.scene.source_filename,acquisition:N.scene.identification.zeroDopplerStartTime,layer:N.layer.id,bbox:N.bbox,selection:N.region,pixel_spacing_m:N.layer.pixel_spacing_m,display:N.layer.display,terrain:N.dem?{source:N.dem.source,min_m:N.dem.min_elevation_m,max_m:N.dem.max_elevation_m,mesh_spacing_m:N.dem.mesh_spacing_m}:null,change_analysis:'Unavailable: only one acquisition is loaded'};const url=URL.createObjectURL(new Blob([JSON.stringify(evidence,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='nisar-scene-evidence.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  window.NisarIntegration={enter,leave,update(){updateNativeUI();if(state.slope!==N.lastSlope){N.lastSlope=state.slope;updateSlope();}},drawTerrain:drawTerrainReal,toggleDetail(){N.map.getZoom()>=N.layer.native_zoom?fit():detail();},exportEvidence,get data(){return N;}};
  $('terrain').addEventListener('close',()=>N.terrainVersion++);
  window.addEventListener('resize',()=>{if(N.map)N.map.invalidateSize();renderThree();});
  if(state.mode==='nisar')enter();
})();

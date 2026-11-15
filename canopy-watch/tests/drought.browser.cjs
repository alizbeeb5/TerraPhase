const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');const fs=require('node:fs');
(async()=>{
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const base='http://127.0.0.1:3012';
 await page.goto(base+'/?type=drought');
 await page.locator('#site-list li:not([hidden])').waitFor();
 assert.equal(await page.locator('#site-list li:not([hidden])').count(),3);
 await page.locator('#site-list').getByRole('button',{name:/Louisiana rainfall and radar/}).click();
 await page.locator('#explore-link').click();
 await page.getByRole('heading',{name:'Seasonal precipitation anomaly · mm'}).waitFor();
 assert.match(await page.locator('.drought-workspace').innerText(),/Provisional radar evidence/);
 await page.waitForFunction(()=>[...document.querySelectorAll('.radar-viewport img')].every(i=>i.complete&&i.naturalWidth>0));
 await page.getByRole('button',{name:'Zoom in',exact:true}).click();
 assert.equal(await page.locator('.radar-viewport img').first().evaluate(i=>i.style.width),'150%');
 fs.mkdirSync('../data/validation/drought',{recursive:true});
 await page.screenshot({path:'../data/validation/drought/desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'../data/validation/drought/mobile.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByRole('link',{name:/Back to globe/}).click();
 assert.equal(new URL(page.url()).searchParams.get('type'),'drought');
 await page.locator('#site-search').fill('Brazil');
 await page.getByText('No sites match your search.').waitFor();
 assert.equal(await page.locator('#site-list li:not([hidden])').count(),0);
 await page.reload();await page.getByText('No sites match your search.').waitFor();
 await page.getByText('Forest disturbance',{exact:true}).click();
 assert.equal(await page.locator('#site-list li:not([hidden])').count(),1);
 for(const id of ['rondonia','louisiana']){
  await page.goto(base+'/?event='+id+'&type=forest-disturbance');
  await page.locator('#comparison').waitFor();
  await page.waitForFunction(()=>document.querySelector('#comparison')?.textContent.includes('dB'));
 }
 await page.goto(base+'/?event=louisiana-drought&type=drought');
 await page.getByRole('heading',{name:'Seasonal precipitation anomaly · mm'}).waitFor();
 for(const id of ['north-florida-drought','eastern-north-carolina-drought']){
  await page.goto(base+'/?event='+id+'&type=drought');
  await page.getByRole('heading',{name:'NISAR radar previews'}).waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('.radar-viewport img')].every(i=>i.complete&&i.naturalWidth>0));
  await page.getByLabel('Radar polarization').selectOption('HH');
  assert.ok((await page.locator('.radar-viewport img').first().getAttribute('src')).endsWith('-HH.webp'));
 }
 assert.deepEqual(errors,[]);console.log('PASS drought routing, filtering, empty state, zoom, mobile, and both forest links');
}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});

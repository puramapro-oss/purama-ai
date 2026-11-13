// Trusted acceptance check lives outside the model's allowed paths.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
const html=await readFile(resolve('index.html'),'utf8');
assert(Buffer.byteLength(html)<=200*1024,'HTML too large');
assert(!html.includes('\0'),'Invalid HTML');
const browser=await chromium.launch({
  ...((process.argv[2] ?? process.env.PLAYWRIGHT_EXECUTABLE_PATH) ? {executablePath:process.argv[2] ?? process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {}),
  headless:true,
});
try {
  const page=await browser.newPage();
  const errors=[];const requests=[];
  page.on('pageerror',error=>errors.push(error.name));
  await page.route('**/*',route=>{requests.push(route.request().resourceType());return route.abort();});
  await page.setContent(html,{waitUntil:'load'});
  assert.equal(await page.title(),'Atelier PURAMA');
  assert.equal(await page.locator('html').getAttribute('lang'),'fr');
  await page.getByRole('button',{name:'Ajouter une unité',exact:true}).click({clickCount:3});
  await page.getByRole('button',{name:'Ajouter une unité',exact:true}).focus();
  await page.keyboard.press('Enter');
  assert.equal((await page.locator('#counter').innerText()).trim(),'4');
  await page.setViewportSize({width:320,height:800});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile overflow');
  assert.deepEqual(errors,[],'Browser error');
  assert.deepEqual(requests,[],'Unexpected external request');
  console.log(JSON.stringify({verified:true,title:'Atelier PURAMA',counter:4,viewport:320,externalRequests:0,pageErrors:0}));
} finally {await browser.close();}

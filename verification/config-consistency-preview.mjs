import {chromium} from '../.dev/browser/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
const browser=await chromium.launch({channel:'msedge',headless:true})
const report={checks:[],errors:[],apiRequests:[],passed:false}
try{
 const p=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'})
 p.on('pageerror',e=>report.errors.push(e.message));p.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))report.apiRequests.push(r.url())})
 await p.goto('http://127.0.0.1:15175/settings/preview?scenario=conflict')
 await p.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.disabled===false)
 await p.locator('#setting-replenishRate').fill('40');await p.locator('.settings-save').click()
 await p.locator('.settings-version-conflict').waitFor()
 await p.locator('.settings-version-details summary').click()
 for(const [label,suffix] of [['存储已确认版本',':2'],['本实例已采用版本',':2'],['最近提交的预期版本',':1']]){
  const input=p.getByRole('textbox',{name:label,exact:true});assert.ok((await input.inputValue()).endsWith(suffix))
  await input.focus();assert.equal(await input.evaluate(el=>el.selectionEnd-el.selectionStart),38)
 }
 report.checks.push('Conflict preview exposes separate stored, adopted and submitted versions; complete values are selectable for copying')
 await p.getByRole('button',{name:'已核对，允许再次提交',exact:true}).click();await p.locator('.settings-save').click()
 await p.waitForFunction(()=>document.querySelector('.settings-write-message')?.textContent.includes('保存已确认'))
 assert.equal(await p.locator('#setting-monitorWindowSeconds').inputValue(),'30')
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.apiRequests,[])
 report.checks.push('Explicit reviewed retry keeps the other change and makes no management API requests');report.passed=true
}finally{await browser.close();await writeFile('.dev/config-consistency/preview-validation.json',JSON.stringify(report,null,2)+'\n')}
console.log(JSON.stringify(report))

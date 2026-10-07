// Recording owns its loopback server even if launching the browser fails before a page exists.
export async function finishRecording({page,context,browser,server},{title,screenshotPath,videoPath}){
 let failure
 try{
  if(page){await page.waitForFunction(expected=>document.querySelector('#current')?.textContent===expected,title,{timeout:3000});await page.screenshot({path:screenshotPath})}
 }catch(error){failure=error}
 try{
  const video=page?.video();if(context)await context.close();if(video)await video.saveAs(videoPath)
 }catch(error){failure||=error}
 finally{
  try{if(browser)await browser.close()}
  finally{if(server)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
 }
 if(failure)throw failure
}

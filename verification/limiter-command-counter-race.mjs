// Reuse the exact compiled callback test against two separately identified production JARs.
// No gateway or Redis is started. All extracted classes go into a fresh evidence directory.
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {resolve,join,delimiter} from 'node:path'
import {createHash} from 'node:crypto'
if(process.argv.length!==6||!process.env.JAVA_HOME)throw Error('Usage: JAVA_HOME=JDK21 node verification/limiter-command-counter-race.mjs <old.jar> <new.jar> <built-backend-dir> <new-output-dir>')
const [oldJar,newJar,backend,out]=process.argv.slice(2).map(x=>resolve(x)),exec=promisify(execFile)
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex')
const tool=name=>join(process.env.JAVA_HOME,'bin',name+(process.platform==='win32'?'.exe':''))
await mkdir(out,{recursive:false})
const xmlPath=join(backend,'target/surefire-reports/TEST-com.zch.ratelimit.RedisRateLimiterCommandTest.xml'),xml=await readFile(xmlPath,'utf8')
const cp=xml.match(/<property name="java.class.path" value="([^"]+)"/)[1].replaceAll('&quot;','"').replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>')
// Production dependencies come from each JAR; only the assertion/mocking libraries come from Maven.
const dependencies=cp.split(delimiter).filter(p=>/[/\\](mockito-core|byte-buddy|byte-buddy-agent|objenesis|junit-jupiter-api|junit-platform-commons|opentest4j|apiguardian-api)[/\\]/.test(p))
assert(dependencies.some(p=>p.includes('mockito-core')))
const testRoot=join(backend,'target/test-classes'),source=join(backend,'src/test/java/com/zch/ratelimit/RedisRateLimiterCommandTest.java')
const report={startedAt:new Date().toISOString(),scope:'Deterministic local callback scheduling; no Redis traffic',javaHome:process.env.JAVA_HOME,
 fixture:{source,sourceSha256:await hash(source),surefireReportSha256:await hash(xmlPath),testClasses:[],dependencies:[]},runs:[],passed:false}
for(const name of await readdir(join(testRoot,'com/zch/ratelimit')))if(name.startsWith('RedisRateLimiterCommandTest')||name.startsWith('RedisRateLimiterHandoffTest')){
 const path=join(testRoot,'com/zch/ratelimit',name);report.fixture.testClasses.push({path,sha256:await hash(path)})
}
for(const path of dependencies)report.fixture.dependencies.push({path,sha256:await hash(path)})
try{
 for(const [label,jar,expectedExit,expectedCount] of [['old',oldJar,1,2],['new',newJar,0,1]]){
  const dir=join(out,label);await mkdir(dir)
  await exec(tool('jar'),['xf',jar,'BOOT-INF/classes','BOOT-INF/lib'],{cwd:dir,windowsHide:true,timeout:60000,maxBuffer:1024*1024})
  const args=['-cp',[testRoot,join(dir,'BOOT-INF/classes'),join(dir,'BOOT-INF/lib','*'),...dependencies].join(delimiter),'com.zch.ratelimit.RedisRateLimiterCommandTest']
  let stdout='',stderr='',exitCode=0
  try{({stdout,stderr}=await exec(tool('java'),args,{windowsHide:true,timeout:30000,maxBuffer:2*1024*1024}))}
  catch(e){stdout=e.stdout||'';stderr=e.stderr||'';exitCode=e.code}
  await writeFile(join(dir,'result.log'),stdout+stderr)
  const row={label,jar,jarSha256:await hash(jar),productionClassSha256:await hash(join(dir,'BOOT-INF/classes/com/zch/ratelimit/RedisRateLimiter$Command.class')),exitCode,observation:JSON.parse(stdout.split(/\r?\n/).find(s=>s.startsWith('{')))}
  report.runs.push(row);assert.equal(exitCode,expectedExit);assert.equal(row.observation.actualWaitingFlags,1)
  assert.equal(row.observation.reportedInFlight,expectedCount);assert.equal(row.observation.reportedPeak,expectedCount);assert.equal(row.observation.settledInFlight,0);assert.equal(row.observation.settlements,2)
 }
 report.passed=true
}catch(e){report.error=e.stack;process.exitCode=1}
finally{report.finishedAt=new Date().toISOString();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,runs:report.runs},null,2))}

import {spawn} from 'node:child_process'
import {join} from 'node:path'
if(!process.env.JAVA_HOME)throw new Error('JAVA_HOME (JDK 21) required')
const child=spawn(join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'),['-XX:ActiveProcessorCount=4','-Dloader.main=com.zch.route.RouteStorageTool','-cp',process.env.ROUTE_PUBLICATION_JAR||'backend/target/zg-1.0.0.jar','org.springframework.boot.loader.launch.PropertiesLauncher',...process.argv.slice(2)],{windowsHide:true,stdio:'inherit'})
child.on('error',error=>{console.error(error);process.exitCode=1});child.on('exit',code=>{process.exitCode=code??1})

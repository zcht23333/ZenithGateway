// Ownership is opt-in for the unified runner. Existing standalone entrypoints keep their behavior.
import {spawn} from 'node:child_process'
import {appendFileSync} from 'node:fs'
import {basename} from 'node:path'
export function scope(env=process.env) {
 const value=env.ZENITH_ACCEPTANCE_SCOPE
 if (value && !/^zg-[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid acceptance scope')
 return value
}
export function scopedDockerArgs(args, env=process.env) {
 const id=scope(env)
 if (!id) return args
 if (args[0]==='run' || args[0]==='create') return [args[0],'--label','zenith.acceptance='+id,...args.slice(1)]
 if (['network','volume'].includes(args[0]) && args[1]==='create') return [...args.slice(0,2),'--label','zenith.acceptance='+id,...args.slice(2)]
 return args
}
export function ownedSpawn(command, args, options={}) {
 const env=options.env || process.env, id=scope(env), java=/^java(?:\.exe)?$/i.test(basename(command))
 const effective=id && java ? ['-Dzenith.verification.run='+id,...args] : args
 const child=spawn(command,effective,options)
 if (id && java && env.ZENITH_ACCEPTANCE_PROCESS_LEDGER) child.once('spawn',()=>{
  appendFileSync(env.ZENITH_ACCEPTANCE_PROCESS_LEDGER,JSON.stringify({pid:child.pid,marker:'-Dzenith.verification.run='+id,command,createdAt:new Date().toISOString()})+'\n')
 })
 return child
}

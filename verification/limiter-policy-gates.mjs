import assert from 'node:assert/strict'

export function assertLimiterBounds(d){
 for(const [name,max] of [['commandsInFlight',d.workers],['activeWorkers',d.workers],['queued',d.queueCapacity],
  ['connectionSlots',d.workers],['closing',d.workers],['scheduledTasks',d.admissionCapacity+1],
  ['queuedDeliveries',d.deliveryQueueCapacity],['activeDeliveries',d.resultWorkers],
  ['retainedTasks',d.admissionCapacity],['availableDecisionPermits',d.admissionCapacity]]){
  assert(Number.isInteger(d[name])&&d[name]>=0&&d[name]<=max,'Limiter resource out of bounds: '+name)
 }
}
export function fullyIdle(d){
 assertLimiterBounds(d)
 return d.commandsInFlight===0&&d.queued===0&&d.activeWorkers===0&&d.closing===0&&d.queuedDeliveries===0&&d.activeDeliveries===0&&d.retainedTasks===0&&d.availableDecisionPermits===d.admissionCapacity
}
// A fault intentionally blocks probes too. Do not wait for a lucky gap between them.
// The RESP fixture must prove physical closure of every held business command first.
export function faultRequestsRetired(d,businessCommands){
 assertLimiterBounds(d)
 return businessCommands.length>0&&businessCommands.every(c=>c.limiter===true&&c.discardedOnClose===true)
  &&d.retainedTasks===0&&d.availableDecisionPermits===d.admissionCapacity&&d.queued===0&&d.closing===0
  &&d.queuedDeliveries===0&&d.activeDeliveries===0&&d.activeInlineDeliveries===0&&d.quarantined===0
  &&d.commandsInFlight<=1&&d.activeWorkers<=1
  &&((d.commandsInFlight===0&&d.activeWorkers===0)||d.transportState==='probing')
}

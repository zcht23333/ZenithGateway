import test from 'node:test'
import assert from 'node:assert/strict'
import {fullyIdle,faultRequestsRetired} from './limiter-policy-gates.mjs'
const idle={workers:1,queueCapacity:1,admissionCapacity:2,deliveryQueueCapacity:0,resultWorkers:0,
 commandsInFlight:0,activeWorkers:0,queued:0,connectionSlots:1,closing:0,scheduledTasks:1,
 queuedDeliveries:0,activeDeliveries:0,activeInlineDeliveries:0,retainedTasks:0,availableDecisionPermits:2,quarantined:0,transportState:'healthy'}
const retired=[{limiter:true,discardedOnClose:true}]
test('continuous bounded recovery probes do not hide physically retired business commands',()=>{
 const samples=Array.from({length:50},()=>({...idle,commandsInFlight:1,activeWorkers:1,transportState:'probing'}))
 assert.equal(samples.some(fullyIdle),false,'Previous all-zero wait cannot finish in this controlled schedule')
 assert(samples.every(d=>faultRequestsRetired(d,retired)))
})
test('HTTP completion and a server reply alone cannot prove business resource release',()=>{
 assert.equal(faultRequestsRetired(idle,[]),false)
 assert.equal(faultRequestsRetired(idle,[{limiter:true,repliedAt:'2026-10-08',discardedOnClose:false}]),false)
 assert.equal(faultRequestsRetired({...idle,retainedTasks:1,availableDecisionPermits:1},retired),false)
 assert.equal(faultRequestsRetired({...idle,closing:1},retired),false)
 assert.equal(faultRequestsRetired({...idle,quarantined:1},retired),false)
})
test('probe allowance never permits unclassified work or exceeds the existing limits',()=>{
 assert.equal(faultRequestsRetired({...idle,commandsInFlight:1,activeWorkers:1},retired),false)
 for(const patch of [{commandsInFlight:2},{activeWorkers:2},{commandsInFlight:-1},{availableDecisionPermits:3},{queued:2},{scheduledTasks:4}])
  assert.throws(()=>faultRequestsRetired({...idle,...patch},retired),/out of bounds/)
})
test('after recovery the original all-zero gate still detects residual commands and workers',()=>{
 assert.equal(fullyIdle(idle),true)
 for(const patch of [{commandsInFlight:1},{activeWorkers:1},{queued:1},{closing:1},{retainedTasks:1,availableDecisionPermits:1}])assert.equal(fullyIdle({...idle,...patch}),false)
})

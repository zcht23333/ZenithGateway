import {test} from 'node:test'
import assert from 'node:assert/strict'
import {middleLabel, uniqueRouteLabels, matchingExample, rewriteExample} from '../src/routes/routeIllustration.ts'
const route={id:'orders',path:'/api/orders/**',uri:'http://order.internal:8080',
 rewriteEnabled:true,rewriteRegex:'^/api/orders/(?<segment>.*)$',rewriteReplacement:'/${segment}',
 circuitBreakerEnabled:true,circuitBreakerName:'cb-orders',fallbackPath:'/fallback/default'}
test('the existing named-segment rule illustrates a real path change',()=>{
 assert.deepEqual(rewriteExample(route),{before:'/api/orders/123',after:'/123'})
 assert.deepEqual(rewriteExample({...route,rewriteReplacement:'/v2/${segment}'}),{before:'/api/orders/123',after:'/v2/123'})
})
test('a disabled rewrite preserves the incoming example even with null fields',()=>{
 assert.deepEqual(rewriteExample({...route,rewriteEnabled:false,rewriteRegex:null,rewriteReplacement:null}),{before:'/api/orders/123',after:'/api/orders/123'})
})
test('backend-generated Java-quoted prefixes are supported',()=>{
 assert.deepEqual(rewriteExample({...route,path:'/api.v1/orders/**',rewriteRegex:'^\\Q/api.v1/orders\\E/(?<segment>.*)$'}),{before:'/api.v1/orders/123',after:'/123'})
})
test('unrecognised Java regex, replacement groups and Spring patterns never get fabricated examples',()=>{
 assert.equal(rewriteExample({...route,rewriteRegex:'(?i)^/api/orders/(?<segment>.*)$'}),null)
 assert.equal(rewriteExample({...route,rewriteReplacement:'/$1'}),null)
 assert.equal(rewriteExample({...route,rewriteReplacement:'//${segment}'}),null)
 assert.equal(matchingExample({...route,path:'/api/{id}/**'}),null)
 assert.equal(matchingExample({...route,path:'/api/*/orders/**'}),null)
})
test('compact directory labels fall back to complete IDs when shortening would collide',()=>{
 const start='asia-pacific-enterprise-order-',end='-settlement-service-v2'
 const a=start+'north-branch-alpha'+end,b=start+'south-branch-beta'+end
 assert.equal(middleLabel(a),middleLabel(b))
 const labels=uniqueRouteLabels([{id:a},{id:b},{id:'order-service'}])
 assert.equal(labels.get(a),a);assert.equal(labels.get(b),b);assert.equal(labels.get('order-service'),'order-service')
})

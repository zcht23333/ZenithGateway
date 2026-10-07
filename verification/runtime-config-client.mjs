import {randomUUID} from 'node:crypto'
// Explicit six-field payload extraction; callers supply the version they actually reviewed.
export const runtimeFields=['rateLimitEnabled','replenishRate','burstCapacity','requestedTokens','monitorWindowSeconds','emitIntervalSeconds']
export const runtimeValues=config=>Object.fromEntries(runtimeFields.map(key=>[key,config[key]]))
export const runtimeRequest=(config,expectedVersion=config.version,operationId=randomUUID())=>({...runtimeValues(config),expectedVersion,operationId})
export function runtimeFixture(config,revision=1,confirmation='read') {
 const snapshot={...runtimeValues(config),version:'00000000-0000-0000-0000-000000000001:'+revision}
 return {...snapshot,source:'redis',confirmation,adopted:snapshot}
}

export const runtimeReceipt=(request,before,after,recordedAt=Date.now())=>({operationId:request.operationId,expectedVersion:request.expectedVersion,
 request:runtimeValues(request),before:{...runtimeValues(before),version:before.version},after:{...runtimeValues(after),version:after.version},
 status:'committed',recordedAt,expiresAt:recordedAt+86400000,instanceId:'00000000-0000-0000-0000-000000000001'})

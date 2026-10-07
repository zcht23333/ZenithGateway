// Setup/verification clients read once before an intentional mutation. No retry, fallback or 409 replay.
// Interactive editors must retain their own reviewed version instead of using this setup helper.
export async function withRouteVersion(readCurrent,options) {
 const method=(options.method||'GET').toUpperCase()
 if(!['POST','DELETE'].includes(method))return options
 const body=options.body?JSON.parse(options.body):{}
 if(body.expectedVersion)return options
 const reply=await readCurrent(),current=reply.body??reply
 if(typeof current.version!=='string'||!Array.isArray(current.routes))throw new Error('Versioned route API required; upgrade this deployment before writing')
 return {...options,body:JSON.stringify(method==='POST'?{expectedVersion:current.version,route:body}:{expectedVersion:current.version})}
}

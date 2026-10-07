import http from 'node:http'
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end('{"ok":true}')
})
server.listen(Number(process.env.PORT || 8081), '0.0.0.0')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))

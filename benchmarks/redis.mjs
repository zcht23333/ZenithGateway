import net from 'node:net'

export function redisCommand(port, args, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: options.host || '127.0.0.1', port })
    let data = Buffer.alloc(0)
    const finish = (error, result) => { socket.destroy(); error ? reject(error) : resolve(result) }
    socket.setTimeout(10000, () => finish(new Error('Redis command timeout')))
    socket.once('error', error => finish(error))
    const commands = []
    if (options.password) commands.push(options.username ? ['AUTH', options.username, options.password] : ['AUTH', options.password])
    if (options.database) commands.push(['SELECT', options.database])
    commands.push(args)
    function sendNext() {
      const command = commands.shift()
      socket.write('*' + command.length + '\r\n' + command.map(arg => {
        const value = String(arg)
        return '$' + Buffer.byteLength(value) + '\r\n' + value + '\r\n'
      }).join(''))
    }
    socket.once('connect', sendNext)
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk])
      try {
        const parsed = parse(data, 0)
        if (parsed) {
          data = data.subarray(parsed.next)
          if (commands.length) sendNext()
          else finish(null, parsed.value)
        }
      } catch (error) { finish(error) }
    })
  })
}
function parse(buffer, offset) {
  const end = buffer.indexOf('\r\n', offset)
  if (end < 0) return null
  const type = String.fromCharCode(buffer[offset]), line = buffer.toString('utf8', offset + 1, end)
  let next = end + 2
  if (type === '-') throw new Error(line)
  if (type === '+') return { value: line, next }
  if (type === ':') return { value: Number(line), next }
  if (type === '$') {
    const length = Number(line)
    if (length === -1) return { value: null, next }
    if (buffer.length < next + length + 2) return null
    return { value: buffer.toString('utf8', next, next + length), next: next + length + 2 }
  }
  if (type === '*') {
    const value = []
    for (let i = 0; i < Number(line); i++) {
      const item = parse(buffer, next)
      if (!item) return null
      value.push(item.value); next = item.next
    }
    return { value, next }
  }
  throw new Error('Unsupported Redis response')
}

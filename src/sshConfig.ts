export type SshProfile = { alias: string; host: string; username: string; port: string; identityFiles: string[]; problems: string[] }
type Block = { patterns: string[]; values: Map<string, string[]> }

// Parse data only. Never execute commands or follow paths mentioned in a config.
function tokens(line: string): string[] {
  const result: string[] = []
  let value = '', quote = ''
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quote) {
      if (char === quote) quote = ''
      else value += char
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#') break
    else if (/\s/.test(char)) { if (value) { result.push(value); value = '' } }
    else value += char
  }
  if (value) result.push(value)
  return result
}

function matches(patterns: string[], alias: string) {
  let found = false
  for (const item of patterns) {
    const negative = item.startsWith('!')
    const pattern = negative ? item.slice(1) : item
    const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
    if (regex.test(alias)) { if (negative) return false; found = true }
  }
  return found
}

export function parseSshConfig(source: string): SshProfile[] {
  const blocks: Block[] = [{ patterns: ['*'], values: new Map() }]
  const aliases = new Set<string>()
  const globalProblems = new Set<string>()
  let current: Block | null = blocks[0]
  for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^(\S+?)\s*=\s*/, '$1 ')
    const parts = tokens(line)
    if (!parts.length) continue
    const keyword = parts.shift()!.toLowerCase()
    if (keyword === 'host') {
      current = { patterns: parts, values: new Map() }; blocks.push(current)
      for (const alias of parts) if (!/[!*?]/.test(alias)) aliases.add(alias)
    } else if (keyword === 'match' || keyword === 'include') {
      globalProblems.add(`${keyword === 'match' ? 'Match conditions' : 'Include files'} need manual review; this importer cannot resolve them.`)
      if (keyword === 'match') current = null
    } else if (current && parts.length) {
      if (keyword === 'identityfile') current.values.set(keyword, [...(current.values.get(keyword) || []), parts.join(' ')])
      else if (!current.values.has(keyword)) current.values.set(keyword, [parts.join(' ')])
    }
  }
  return [...aliases].map((alias) => {
    const values = new Map<string, string[]>()
    for (const block of blocks) if (matches(block.patterns, alias)) {
      for (const [key, items] of block.values) {
        if (key === 'identityfile') values.set(key, [...(values.get(key) || []), ...items])
        else if (!values.has(key)) values.set(key, items)
      }
    }
    const first = (key: string) => values.get(key)?.[0] || ''
    const host = (first('hostname') || alias).replace(/%[hn]/g, alias)
    const username = first('user'), port = first('port') || '22'
    const problems = [...globalProblems]
    if (/\s|:\/\/|[/?#%]/.test(host)) problems.push('HostName must be a hostname or IP address, without https:// or a URL path. Cloudflare Access SSH requires a separate transport.')
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) problems.push('Port must be between 1 and 65535.')
    for (const option of ['proxycommand', 'proxyjump']) if (first(option) && first(option).toLowerCase() !== 'none') problems.push(`${option === 'proxycommand' ? 'ProxyCommand' : 'ProxyJump'} is required by this entry and is not supported by Orbit yet.`)
    return { alias, host, username, port, identityFiles: [...new Set(values.get('identityfile') || [])], problems }
  })
}

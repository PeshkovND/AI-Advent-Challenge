/** Shared allowlist boundary for corpus paths and MCP metadata. No file contents are exposed by Git tools. */
export function publicProjectPath(path: string) {
  return !path.split(/[\\/]/).some((part) => part.startsWith('.') || /^(node_modules|dist|dist-private-llm|data|coverage|build)$/i.test(part)
    || /(?:^|[-_.])(secret|secrets|credential|credentials|token|tokens|password|private[-_]?key)(?:$|[-_.])/i.test(part)
    || /\.(pem|key|p12|pfx)$/i.test(part))
}

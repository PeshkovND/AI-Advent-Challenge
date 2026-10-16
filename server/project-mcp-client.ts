import { Client } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { ProjectReceipt } from '../src/developer-types'

/** A short-lived, real MCP stdio connection; receipts never come from an LLM. */
export async function readProjectContext(root: string, signal?: AbortSignal) {
  const client = new Client({ name: 'developer-assistant', version: '1.0.0' })
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', fileURLToPath(new URL('./project-mcp-server.ts', import.meta.url))],
    env: { ...getDefaultEnvironment(), DEVELOPER_PROJECT_ROOT: root },
  })
  try {
    signal?.throwIfAborted()
    await client.connect(transport, { timeout: 10000, signal })
    const receipts: ProjectReceipt[] = []
    for (const name of ['get_git_branch', 'list_project_files', 'get_git_diff', 'list_git_branches']) {
      signal?.throwIfAborted()
      const response = await client.callTool({ name, arguments: {} }, { timeout: 10000, signal })
      if (response.isError || !response.structuredContent) throw new Error(`MCP ${name}: не получен контекст проекта.`)
      receipts.push({ name, result: z.record(z.string(), z.unknown()).parse(response.structuredContent) })
    }
    return { capturedAt: new Date().toISOString(), receipts }
  } finally { await client.close(); await transport.close() }
}

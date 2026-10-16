import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { ProjectWorkspace } from './project-workspace'

const workspace = new ProjectWorkspace(process.env.DEVELOPER_PROJECT_ROOT || process.cwd())
serveStdio(() => {
  const server = new McpServer({ name: 'project-context', version: '1.1.0' })
  function register(name: string, description: string, operation: () => Promise<Record<string, unknown>>) {
    server.registerTool(name, {
      description, inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => {
      try {
        const result = await operation()
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result }
      } catch {
        return { isError: true, content: [{ type: 'text' as const, text: 'Не удалось прочитать Git-контекст проекта.' }] }
      }
    })
  }
  register('get_git_branch', 'Текущая Git-ветка, commit и detached HEAD.', () => workspace.branch())
  register('list_git_branches', 'Локальные и известные локальной копии удалённые ветки, отдельно с количеством и признаком усечения. Без fetch; origin/HEAD исключён.', () => workspace.branches())
  register('list_project_files', 'Первые 120 отслеживаемых файлов проекта; скрытые и служебные пути исключены.', () => workspace.files())
  register('get_git_diff', 'Имена и статусы staged/unstaged изменений отслеживаемых файлов, без содержимого.', () => workspace.diff())
  return server
}, { onerror: (error) => console.error('Project MCP:', error) })

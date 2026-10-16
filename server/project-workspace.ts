import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
/** Shared allowlist boundary for corpus paths and MCP metadata. No file contents are exposed by Git tools. */
export function publicProjectPath(path: string) {
  return !path.split(/[\\/]/).some((part) => part.startsWith('.') || /^(node_modules|dist|dist-private-llm|data|coverage|build)$/i.test(part)
    || /(?:^|[-_.])(secret|secrets|credential|credentials|token|tokens|password|private[-_]?key)(?:$|[-_.])/i.test(part)
    || /\.(pem|key|p12|pfx)$/i.test(part))
}

export class ProjectWorkspace {
  constructor(readonly root: string) {}
  private repositoryCheck?: Promise<boolean>
  private repository() {
    return this.repositoryCheck ||= this.git(['rev-parse', '--is-inside-work-tree']).then((value) => value.trim() === 'true').catch((error: { stderr?: string }) => {
      if (error.stderr?.includes('not a git repository')) return false
      throw error
    })
  }
  private noRepository() { return { available: false, reason: 'Выбранная папка не находится в Git-репозитории.' } }

  private async git(args: string[]) {
    const { stdout } = await execute('git', ['--no-optional-locks', '-C', this.root, ...args], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    })
    return stdout
  }

  async branch() {
    if (!await this.repository()) return this.noRepository()
    const branch = (await this.git(['branch', '--show-current'])).trim() || null
    let commit: string | null = null
    try { commit = (await this.git(['rev-parse', '--verify', '--quiet', 'HEAD'])).trim() }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error }
    return { branch, commit, detached: branch === null }
  }

  async branches(limit = 200) {
    if (!await this.repository()) return this.noRepository()
    const refs = (await this.git(['for-each-ref', '--sort=refname', '--format=%(refname)%00%(symref)', 'refs/heads', 'refs/remotes'])).split('\n')
    const local: string[] = [], remote: string[] = []
    for (const line of refs) {
      const [ref, symbolic] = line.split('\0')
      // origin/HEAD is a symbolic pointer to a default branch, not another branch.
      if (!ref || symbolic) continue
      if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length))
      if (ref.startsWith('refs/remotes/')) remote.push(ref.slice('refs/remotes/'.length))
    }
    const select = (names: string[]) => ({ branches: names.slice(0, limit), total: names.length, truncated: names.length > limit })
    return { local: select(local), remote: select(remote), scope: 'local branches and locally known remote-tracking branches; no fetch or network request; remote refs may be stale' }
  }

  async files(limit = 120) {
    if (!await this.repository()) return this.noRepository()
    const files = (await this.git(['ls-files', '-z'])).split('\0').filter((file) => file && publicProjectPath(file)).sort()
    return { files: files.slice(0, limit), total: files.length, truncated: files.length > limit }
  }

  async diff(limit = 60) {
    if (!await this.repository()) return this.noRepository()
    const read = async (staged: boolean) => {
      const fields = (await this.git(['diff', ...(staged ? ['--cached'] : []), '--no-ext-diff', '--no-renames', '--name-status', '-z', '--', '.'])).split('\0')
      const changes: Array<{ status: string; path: string }> = []
      for (let index = 0; index + 1 < fields.length; index += 2) {
        if (publicProjectPath(fields[index + 1])) changes.push({ status: fields[index], path: fields[index + 1] })
      }
      return { changes: changes.slice(0, limit), total: changes.length, truncated: changes.length > limit }
    }
    return { staged: await read(true), unstaged: await read(false), scope: 'tracked files; names and statuses only' }
  }
}

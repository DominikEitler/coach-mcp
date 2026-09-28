import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
  unlink,
  mkdir,
  rmdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const sections = ['coach', 'athlete', 'season', 'blocks', 'weeks', 'races', 'notes'];
// The coach handbook and foundational context (zones, health, goals, race priorities) change
// only with recorded athlete approval.
export const protectedSections = ['coach', 'athlete', 'season'];
export const isProtected = (path: string) => protectedSections.includes(path.split('/')[0]!);
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export class DataStore {
  constructor(
    readonly root: string,
    private writable = false,
    private push = false,
  ) {}
  private async safePath(path: string) {
    if (!/^(coach|athlete|season|blocks|weeks|races|notes)\/[a-zA-Z0-9_-]+\.md$/.test(path))
      throw new Error('Use section/filename.md in an approved coaching directory.');
    const root = await realpath(this.root);
    const [section] = path.split('/');
    const parent = join(root, section!);
    const parentStat = await lstat(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory())
      throw new Error('Coaching directories must be real directories.');
    const file = join(root, path);
    try {
      const stat = await lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
        throw new Error('Only regular, non-linked Markdown files are supported.');
      if (stat.size > 65536) throw new Error('Document exceeds 64 KiB.');
    } catch (e) {
      if (!missing(e)) throw e;
    }
    return file;
  }
  async list() {
    const files: string[] = [];
    for (const section of sections) {
      let entries;
      try {
        entries = await readdir(join(this.root, section));
      } catch (e) {
        if (missing(e)) continue;
        throw e;
      }
      for (const name of entries) {
        if (!/^[a-zA-Z0-9_-]+\.md$/.test(name)) continue;
        const path = `${section}/${name}`;
        await this.safePath(path);
        files.push(path);
      }
    }
    return files.sort();
  }
  async read(path: string) {
    const file = await this.safePath(path);
    try {
      const content = await readFile(file, 'utf8');
      return { path, content, sha256: digest(content) };
    } catch (e) {
      if (missing(e)) return { path, content: null, sha256: null };
      throw e;
    }
  }
  private async git(...args: string[]) {
    return (
      await exec('git', ['-C', this.root, ...args], { timeout: 30000, maxBuffer: 1024 * 1024 })
    ).stdout.trim();
  }
  async update(
    path: string,
    content: string,
    expected: string | null,
    reason: string,
    confirmation?: string,
  ) {
    if (!this.writable) throw new Error('Data writes are disabled.');
    if (isProtected(path) && !confirmation)
      throw new Error(
        'Protected document: ask the athlete to explicitly approve this change and supply their confirmation.',
      );
    if (Buffer.byteLength(content) > 65536) throw new Error('Document exceeds 64 KiB.');
    const lock = join(this.root, '.coach-write-lock');
    try {
      await mkdir(lock);
    } catch {
      throw new Error(
        'Another write is in progress, or a stale .coach-write-lock requires operator review.',
      );
    }
    let temp: string | undefined;
    let written = false;
    try {
      const file = await this.safePath(path);
      if (await this.git('status', '--porcelain'))
        throw new Error('Data repository must be clean before writing.');
      if (this.push) {
        await this.git('fetch', 'origin');
        if ((await this.git('rev-parse', 'HEAD')) !== (await this.git('rev-parse', '@{u}')))
          throw new Error('Data checkout must match its upstream; synchronize it before writing.');
      }
      const current = await this.read(path);
      if (current.sha256 !== expected)
        throw new Error('Document changed. Read it again before updating.');
      if (current.content === content) return { path, sha256: current.sha256, changed: false };
      temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
      await rename(temp, file);
      temp = undefined;
      written = true;
      await this.git('add', '--', path);
      await this.git(
        '-c',
        'user.name=Coach MCP',
        '-c',
        'user.email=coach-mcp@localhost',
        'commit',
        '-m',
        `coach: ${reason}`,
        ...(confirmation ? ['-m', `Athlete-Confirmation: ${confirmation}`] : []),
        '--',
        path,
      );
      const commit = await this.git('rev-parse', 'HEAD');
      if (this.push) {
        try {
          await this.git('push', 'origin', 'HEAD');
        } catch {
          return {
            path,
            sha256: digest(content),
            commit,
            changed: true,
            synced: false,
            warning:
              'Saved locally, but push failed. Operator must synchronize before the next write.',
          };
        }
      }
      return { path, sha256: digest(content), commit, changed: true, synced: this.push };
    } catch (e) {
      if (written)
        throw new Error(
          'Document was saved but Git recording failed. Operator must inspect the data repository before retrying.',
        );
      // Do not expose Git stderr, remote URLs or filesystem details to clients.
      if (e instanceof Error && !('stderr' in e)) throw e;
      throw new Error('Git operation failed. Check repository setup and upstream access.');
    } finally {
      if (temp) await unlink(temp).catch(() => {});
      await rmdir(lock);
    }
  }
}

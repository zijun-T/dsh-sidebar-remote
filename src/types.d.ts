declare module '@dsh-ssh/dsh-ssh/src/router.js' {
  // env params are typed as Record<string, string | undefined> rather than
  // Record<string, string> so that `process.env` is assignable directly: its
  // index signature carries `undefined`, and the upstream implementation is
  // plain JS that only ever truthiness-checks the keys it reads.
  type Env = Record<string, string | undefined>
  export function remoteRoot(env?: Env): string
  export function isValidHostId(id: string): boolean
  export function encodeRemotePath(p: string): string
  export function decodeRemotePath(s: string): string | null
  export function mapRemoteToLocal(hostId: string, remotePath: string, env?: Env): string | null
  export function mapLocalToRemote(localPath: string, env?: Env): { hostId: string; remotePath: string } | null
  export function routeByCwd(cwd: string, env?: Env): { kind: 'local' } | { kind: 'remote'; hostId: string; remoteCwd: string }
  export function resolveRemotePath(requested: string, remoteCwd: string, placeholderCwd?: string): string
}
declare module '@dsh-ssh/dsh-ssh/src/policy.js' {
  export function isPathInsideWorkspace(target: string, root: string): boolean
  export function mutationDenialMode(mode: string, resolved: string, cwd: string): string | null
  export function sandboxDenialError(mode: string, subject?: string): Error
}
declare module '@dsh-ssh/dsh-ssh/src/ssh-core.js' {
  export class SshError extends Error { constructor(o: { hostId?: string; stage?: string; message?: string; cause?: unknown; host?: string; port?: number; fingerprint?: string; rawKeyBase64?: string; keyType?: string }); hostId: string; stage: string; isHostKeyUnknown: boolean; host?: string; port?: number; fingerprint?: string; rawKeyBase64?: string; keyType?: string }
  export class SshConn {
    hostId: string
    // patched in host apply (ssh-shell-patch.ts) so RemotePty's conn.shell is real
    client: { shell?(w: unknown, o: unknown, cb: (err: unknown, s: unknown)=>void): unknown; exec?(...a: unknown[]): unknown } | null
    connect(): Promise<this>
    exec(cmd: string, opts?: unknown): Promise<{code:number; stdout:string; stderr:string}>
    sftp(): Promise<unknown>
    fs(): Promise<unknown>
    shell?(opts: {term:string; cols:number; rows:number}): Promise<unknown>
  }
  export function shellQuoteSingle(s: string): string
  export function buildRemoteCommand(cmd: string, cwd?: string): string
  export const HOST_KEY_UNKNOWN_STAGE: string
}
declare module '@dsh-ssh/dsh-ssh/src/settings.js' {
  export const HOSTS_NAMESPACE: string
  export function readHostsDoc(get: ((ns: string)=>unknown)|null): { hosts: Record<string, unknown>; doc: unknown; legacy: boolean }
}
declare module '@dsh-ssh/dsh-ssh/src/exec-fs.js' {
  export class ExecFs { constructor(conn: unknown, opts?: unknown); readBytes(p: string): Promise<Buffer>; listDir?(p: string): Promise<{name:string;type:string}[]>; readText?(p: string): Promise<string> }
}

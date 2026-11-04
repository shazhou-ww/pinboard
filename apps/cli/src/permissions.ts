import { execFile } from "node:child_process";
import { lstat, mkdir, open } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { promisify } from "node:util";
import { CliError, missing } from "./errors.js";

const execute = promisify(execFile);

// Paths travel in the environment, never interpolated into executable code.
// The helper only creates/verifies ACLs; it never receives token bytes.
const windowsAcl = `
$ErrorActionPreference = 'Stop'
$p = $env:PINBOARD_ACL_PATH
$action = $env:PINBOARD_ACL_ACTION
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$replaceRights = [System.Security.AccessControl.FileSystemRights]'DeleteSubdirectoriesAndFiles, Delete, ChangePermissions, TakeOwnership'
$parent = [System.IO.Path]::GetDirectoryName($p)
while ($parent) {
  if (([System.IO.File]::GetAttributes($parent) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse ancestor' }
  $parentAcl = [System.IO.Directory]::GetAccessControl($parent)
  if ($trusted -notcontains $parentAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Untrusted parent owner' }
  foreach ($access in $parentAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($access.AccessControlType -eq 'Allow' -and ($access.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $trusted -notcontains $access.IdentityReference.Value -and ($access.FileSystemRights -band $replaceRights) -ne 0) { throw 'Replaceable ancestor' }
  }
  $parent = [System.IO.Path]::GetDirectoryName($parent)
}
if ($action -eq 'directory') {
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $security.AddAccessRule($rule)
  [void][System.IO.Directory]::CreateDirectory($p, $security)
}
if ($action -eq 'file') {
  $security = [System.Security.AccessControl.FileSecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
  $security.AddAccessRule($rule)
  [System.IO.File]::SetAccessControl($p, $security)
}
$attributes = [System.IO.File]::GetAttributes($p)
if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
$acl = if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) { [System.IO.Directory]::GetAccessControl($p) } else { [System.IO.File]::GetAccessControl($p) }
if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unsafe owner or inheritance' }
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1) { throw 'Unexpected ACL entries' }
$rule = $rules[0]
if ($rule.IsInherited -or $rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { throw 'Unsafe DACL' }
`;

async function acl(
  path: string,
  action: "directory" | "file" | "verify",
): Promise<void> {
  try {
    const systemKeys = new Set([
      "path",
      "systemroot",
      "windir",
      "pathext",
      "psmodulepath",
      "userprofile",
      "localappdata",
      "appdata",
      "programfiles",
      "programfiles(x86)",
      "programw6432",
      "comspec",
      "tmp",
      "temp",
    ]);
    const systemEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        systemKeys.has(key.toLowerCase()),
      ),
    );
    const pending = execute(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsAcl],
      {
        env: {
          ...systemEnvironment,
          PINBOARD_ACL_PATH: path,
          PINBOARD_ACL_ACTION: action,
        },
        timeout: 15000,
        windowsHide: true,
        maxBuffer: 16384,
      },
    );
    // Console-less Windows PowerShell must not wait on an unused input pipe.
    pending.child.stdin?.end();
    await pending;
  } catch (error) {
    const failure = new CliError(
      "UNSAFE_PERMISSIONS",
      "Cannot establish or verify a protected current-user Windows DACL. Use a supported local filesystem; move unsafe existing Pinboard files aside manually.",
    );
    failure.cause = error;
    throw failure;
  }
}

export async function noLinks(path: string): Promise<void> {
  let current = resolve(path);
  const root = parse(current).root;
  while (current !== root) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new CliError(
          "UNSAFE_PATH",
          "Symbolic links and reparse paths are not permitted for configuration or credentials.",
        );
    } catch (error) {
      if (!missing(error)) throw error;
    }
    current = dirname(current);
  }
}

export function sameFileIdentity(
  before: BigIntStats,
  after: BigIntStats,
): boolean {
  // Node 22 on Windows reports an unavailable device ID (zero) for path stat,
  // but a volume ID for handle stat. File IDs must still match exactly.
  return (
    before.ino === after.ino &&
    (before.dev === after.dev ||
      (process.platform === "win32" && (before.dev === 0n || after.dev === 0n)))
  );
}

export async function verify(
  path: string,
  directory = false,
): Promise<BigIntStats> {
  await noLinks(path);
  if (directory && process.platform !== "win32") {
    let parent = dirname(resolve(path));
    for (;;) {
      const ancestor = await lstat(parent);
      if (
        !process.getuid ||
        (ancestor.uid !== process.getuid() && ancestor.uid !== 0) ||
        (ancestor.mode & 0o022) !== 0
      )
        throw new CliError(
          "UNSAFE_PERMISSIONS",
          "Configuration ancestors must be owned by this user or root and not writable by other users.",
        );
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  const stat = await lstat(path, { bigint: true });
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
    throw new CliError(
      "UNSAFE_PATH",
      "Expected an owned directory or a single-link regular credentials file.",
    );
  if (process.platform === "win32") {
    await acl(path, "verify");
  } else {
    if (
      !process.getuid ||
      stat.uid !== BigInt(process.getuid()) ||
      (stat.mode & 0o7777n) !== (directory ? 0o700n : 0o600n)
    )
      throw new CliError(
        "UNSAFE_PERMISSIONS",
        "Pinboard requires an owned 0700 directory and single-link 0600 files. Inspect ownership/ACLs and repair manually before retrying.",
      );
    // POSIX ACL named-user/group permissions are bounded by these zero group-mask
    // bits; other is also zero. No non-owner can gain effective access.
  }
  return stat;
}

export async function secureDirectory(path: string): Promise<void> {
  await noLinks(path);
  try {
    await lstat(path);
  } catch (error) {
    if (!missing(error)) throw error;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (process.platform === "win32") await acl(path, "directory");
    else {
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      }
    }
  }
  await verify(path, true);
}

export async function createProtectedFile(path: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  await handle.close();
  if (process.platform === "win32") await acl(path, "file");
  await verify(path);
}

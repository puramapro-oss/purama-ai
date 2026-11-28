import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative } from "node:path";

/**
 * Resolve once before spawning and pass this absolute target to the child process.
 * Relative/empty PATH entries are never executable search roots. A real binary in
 * the generated project is rejected rather than trusted because another Git exists.
 */
export async function resolveTrustedGit(cwd: string, pathValue = process.env.PATH ?? "/usr/bin:/bin"): Promise<string> {
  const root = await realpath(cwd);
  for (const directory of pathValue.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    let executable: string;
    try {
      executable = await realpath(join(directory, "git"));
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
    } catch { continue; }
    const rel = relative(root, executable);
    if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))) {
      throw new Error("Exécutable Git modifiable par le projet refusé");
    }
    return executable;
  }
  throw new Error("Exécutable Git de confiance indisponible");
}

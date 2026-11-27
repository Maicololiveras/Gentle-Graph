import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The ordinary SHA-1 v2/v3 layout documented by gitformat-index. For a large
// checkout this replaces a second Git process. Git still supplies the working
// tree status, ignore rules and untracked files.
export function readTrackedIndexPaths(
  root: string,
  layout?: {dir:string; common:string; prefix:string},
  onEntry?: (file: string, index: Buffer, offset: number) => void
): string[] | undefined {
  if (layout?.prefix) return;
  if (process.env.GIT_INDEX_FILE || process.env.GIT_DIR || process.env.GIT_WORK_TREE ||
      process.env.GIT_COMMON_DIR || process.env.GIT_CONFIG_PARAMETERS || process.env.GIT_CONFIG_COUNT) return;
  const dir = layout?.dir ?? path.join(root, ".git");
  try {
    if (!fs.lstatSync(dir, {throwIfNoEntry:false})?.isDirectory()) return;
    const index = path.join(dir, "index");
    const stat = fs.lstatSync(index, {throwIfNoEntry:false});
    if (!stat?.isFile() || stat.size < 32_000 || stat.size > 32*1024*1024) return;
    // Respect custom worktree locations, config includes and repository formats.
    const config = fs.readFileSync(path.join(layout?.common ?? dir,"config"), "utf8");
    if (/^\s*(?:worktree\s*=|\[include(?:if)?\b|\[extensions\s*\])/im.test(config)) return;
    const bytes = fs.readFileSync(index);
    const version = bytes.readUInt32BE(4), count = bytes.readUInt32BE(8);
    if (bytes.readUInt32BE(0) !== 0x44495243 || (version !== 2 && version !== 3) || count <= 500) return;
    const end = bytes.length - 20;
    if (count > (end - 12) / 64 ||
        !createHash("sha1").update(bytes.subarray(0,end)).digest().equals(bytes.subarray(end))) return;
    const files = new Array<string>(count);
    let offset = 12;
    for (let i=0; i<count; i++) {
      if (offset + 62 >= end) return;
      const flags = bytes.readUInt16BE(offset + 60);
      // Unmerged stages, extended flags (including skip-worktree) and
      // sparse directory entries use the Git CLI path.
      if ((flags & 0x7000) || (bytes.readUInt32BE(offset + 24) & 0xf000) === 0x4000) return;
      const length = flags & 0xfff;
      if (length === 0 || length === 0xfff) return;
      const start = offset + 62, stop = start + length;
      if (stop >= end || bytes[stop] !== 0) return;
      const file = bytes.toString("utf8",start,stop);
      if (/^(?:\/|[A-Za-z]:)|\\|\0|(?:^|\/)(?:\.\.?|\.git)(?:\/|$)/i.test(file)) return;
      files[i] = file;
      onEntry?.(file,bytes,offset);
      offset += Math.ceil((63 + length) / 8) * 8;
    }
    while (offset < end) {
      // Uppercase extension signatures are optional. Mandatory extensions
      // include "link" (split index) and "sdir" (sparse index).
      if (offset + 8 > end || bytes[offset] < 65 || bytes[offset] > 90) return;
      offset += 8 + bytes.readUInt32BE(offset + 4);
    }
    if (offset === end) return files;
  } catch { /* Git handles indexes that changed while reading. */ }
}

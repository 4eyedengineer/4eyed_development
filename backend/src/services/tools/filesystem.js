import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_READ_BYTES = 200 * 1024;       // 200KB read cap
const MAX_WRITE_BYTES = 100 * 1024;      // 100KB write cap
const BINARY_PROBE_BYTES = 8 * 1024;     // first 8KB scanned for null bytes
const SEARCH_RESULT_CAP = 50;
const SEARCH_FILE_CAP = 500;             // don't scan more than 500 files
const DEFAULT_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '.venv', '__pycache__']);

/**
 * Resolve a user-provided path safely inside the sandbox root.
 * Throws if the path escapes the sandbox.
 */
function safeResolve(root, userPath) {
  if (typeof userPath !== 'string') {
    throw new Error('path must be a string');
  }
  // Strip a leading "./" for cosmetics.
  const clean = userPath.replace(/^\.\/+/, '');
  const absolute = path.resolve(root, clean);
  const rootResolved = path.resolve(root);
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) {
    throw new Error(`path "${userPath}" escapes sandbox`);
  }
  return absolute;
}

function isBinarySample(buf) {
  const slice = buf.slice(0, Math.min(buf.length, BINARY_PROBE_BYTES));
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0) return true;
  }
  return false;
}

async function readTextFile(absPath) {
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) {
    throw new Error('not a file');
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`file too large (${stat.size} bytes, max ${MAX_READ_BYTES})`);
  }
  const buf = await fs.readFile(absPath);
  if (isBinarySample(buf)) {
    throw new Error('file appears to be binary');
  }
  return buf.toString('utf8');
}

async function listDirEntries(absPath) {
  const entries = await fs.readdir(absPath, { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    if (DEFAULT_IGNORE.has(ent.name)) continue;
    const full = path.join(absPath, ent.name);
    let size = 0;
    if (ent.isFile()) {
      try {
        const st = await fs.stat(full);
        size = st.size;
      } catch { /* ignore */ }
    }
    out.push({
      name: ent.name,
      type: ent.isDirectory() ? 'dir' : ent.isFile() ? 'file' : 'other',
      size,
    });
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * Recursively walk a directory, yielding text file paths only.
 * Caps walk count to keep search fast.
 */
async function* walkTextFiles(rootAbs, startAbs, limit) {
  const stack = [startAbs];
  let count = 0;
  while (stack.length && count < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { continue; }
    for (const ent of entries) {
      if (DEFAULT_IGNORE.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        if (count >= limit) break;
        count += 1;
        yield full;
      }
    }
  }
}

/**
 * Build the filesystem tool factory.
 *
 * @param {string} sandboxRoot - Absolute directory the tools may touch.
 * @param {object} [options]
 * @param {boolean} [options.writable=false] - When true, expose write_file and str_replace.
 */
export function createFilesystemTools(sandboxRoot, options = {}) {
  const { writable = false } = options;
  const root = path.resolve(sandboxRoot);

  const tools = [
    {
      name: 'read_file',
      description: 'Read the contents of a text file from the repository sandbox. Returns UTF-8 text. Rejects binary files and files larger than 200KB. Use relative paths from the repo root (e.g. "package.json", "src/index.js").',
      input_schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Relative path to file from sandbox root' },
        },
      },
      execute: async ({ path: p }) => {
        try {
          const abs = safeResolve(root, p);
          const text = await readTextFile(abs);
          return text;
        } catch (err) {
          return { content: `Error reading "${p}": ${err.message}`, is_error: true };
        }
      },
    },
    {
      name: 'list_dir',
      description: 'List entries in a directory inside the sandbox. Returns JSON array of {name, type, size}. Skips node_modules, .git, dist, build, .next by default. Defaults to repo root.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path. Defaults to "." (sandbox root).' },
        },
      },
      execute: async ({ path: p = '.' } = {}) => {
        try {
          const abs = safeResolve(root, p);
          const entries = await listDirEntries(abs);
          return JSON.stringify(entries, null, 2);
        } catch (err) {
          return { content: `Error listing "${p}": ${err.message}`, is_error: true };
        }
      },
    },
    {
      name: 'search',
      description: 'Search for a literal substring across text files under a directory. Returns up to 50 matches as JSON array of {file, line_number, line}. Use this to locate code by keyword.',
      input_schema: {
        type: 'object',
        required: ['pattern'],
        properties: {
          pattern: { type: 'string', description: 'Literal substring to search for' },
          path: { type: 'string', description: 'Relative directory to search under. Defaults to "." (sandbox root).' },
        },
      },
      execute: async ({ pattern, path: p = '.' } = {}) => {
        if (!pattern || typeof pattern !== 'string') {
          return { content: 'Error: pattern is required and must be a string', is_error: true };
        }
        try {
          const startAbs = safeResolve(root, p);
          const matches = [];
          for await (const fileAbs of walkTextFiles(root, startAbs, SEARCH_FILE_CAP)) {
            if (matches.length >= SEARCH_RESULT_CAP) break;
            let buf;
            try {
              const st = await fs.stat(fileAbs);
              if (st.size > MAX_READ_BYTES) continue;
              buf = await fs.readFile(fileAbs);
            } catch { continue; }
            if (isBinarySample(buf)) continue;
            const text = buf.toString('utf8');
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(pattern)) {
                matches.push({
                  file: path.relative(root, fileAbs),
                  line_number: i + 1,
                  line: lines[i].length > 300 ? lines[i].slice(0, 300) + '...' : lines[i],
                });
                if (matches.length >= SEARCH_RESULT_CAP) break;
              }
            }
          }
          return JSON.stringify({ matches, capped: matches.length >= SEARCH_RESULT_CAP }, null, 2);
        } catch (err) {
          return { content: `Error searching "${pattern}" in "${p}": ${err.message}`, is_error: true };
        }
      },
    },
  ];

  if (writable) {
    tools.push({
      name: 'write_file',
      description: 'Create or overwrite a text file inside the sandbox. Creates parent directories as needed. Maximum 100KB. Use this to apply fixes — the parent process will pick up modified files after the agent submits.',
      input_schema: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'Relative path from sandbox root' },
          content: { type: 'string', description: 'Full file contents (UTF-8)' },
        },
      },
      execute: async ({ path: p, content }) => {
        try {
          if (typeof content !== 'string') {
            return { content: 'Error: content must be a string', is_error: true };
          }
          const bytes = Buffer.byteLength(content, 'utf8');
          if (bytes > MAX_WRITE_BYTES) {
            return { content: `Error: file too large (${bytes} bytes, max ${MAX_WRITE_BYTES})`, is_error: true };
          }
          const abs = safeResolve(root, p);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, content, 'utf8');
          return `Wrote ${bytes} bytes to ${p}`;
        } catch (err) {
          return { content: `Error writing "${p}": ${err.message}`, is_error: true };
        }
      },
    });

    tools.push({
      name: 'str_replace',
      description: 'Replace exactly one occurrence of old_str with new_str in a file. Errors if old_str is not found, or appears more than once (provide more context to disambiguate). Preserves the rest of the file verbatim.',
      input_schema: {
        type: 'object',
        required: ['path', 'old_str', 'new_str'],
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          old_str: { type: 'string', description: 'Exact text to find (must match exactly once)' },
          new_str: { type: 'string', description: 'Replacement text' },
        },
      },
      execute: async ({ path: p, old_str, new_str }) => {
        try {
          if (typeof old_str !== 'string' || typeof new_str !== 'string') {
            return { content: 'Error: old_str and new_str must be strings', is_error: true };
          }
          const abs = safeResolve(root, p);
          const original = await readTextFile(abs);
          const idx = original.indexOf(old_str);
          if (idx === -1) {
            return { content: `Error: old_str not found in ${p}`, is_error: true };
          }
          const second = original.indexOf(old_str, idx + 1);
          if (second !== -1) {
            return { content: `Error: old_str appears multiple times in ${p}; provide more surrounding context to make it unique`, is_error: true };
          }
          const updated = original.slice(0, idx) + new_str + original.slice(idx + old_str.length);
          const bytes = Buffer.byteLength(updated, 'utf8');
          if (bytes > MAX_WRITE_BYTES) {
            return { content: `Error: resulting file too large (${bytes} bytes, max ${MAX_WRITE_BYTES})`, is_error: true };
          }
          await fs.writeFile(abs, updated, 'utf8');
          return `Replaced 1 occurrence in ${p}`;
        } catch (err) {
          return { content: `Error in str_replace on "${p}": ${err.message}`, is_error: true };
        }
      },
    });
  }

  return tools;
}

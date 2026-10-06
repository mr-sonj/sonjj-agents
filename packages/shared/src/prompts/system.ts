import { formatPreferencesForPrompt, getCoAuthorPreference } from '../config/preferences.ts';
import { getBrowserToolEnabled, getRtkEnabled } from '../config/storage.ts';
import { getRtkPath } from '../agent/core/rtk-detector.ts';
import { loadWorkspaceConfig } from '../workspaces/storage.ts';
import { debug } from '../utils/debug.ts';
import { readFileSync, readdirSync, statSync } from 'fs';
import { isAbsolute, join, relative, basename, resolve, dirname } from 'path';
import { DOC_REFS, APP_ROOT } from '../docs/index.ts';
import { PERMISSION_MODE_CONFIG } from '../agent/mode-types.ts';
import { FEATURE_FLAGS } from '../feature-flags.ts';
import { isDecisionFeatureActive } from '../decisions/resolve.ts';
import { APP_VERSION } from '../version/index.ts';
import { readPluginName } from '../utils/workspace.ts';
import { formatBytes } from '../utils/binary-detection.ts';
import { getWorkspaceSourcesPath, getWorkspaceSkillsPath, getWorkspaceExtraSkillsPaths } from '../workspaces/storage.ts';
import os from 'os';
import type { ProjectPromptContext } from '../projects/types.ts';
import {
  escapePromptXmlAttr,
  sanitizePromptBody,
  sanitizePromptLine,
} from './prompt-sanitize.ts';
import { findGitRepositoryRoot } from './developer-context.ts';

/** Maximum size of CLAUDE.md file to include (10KB) */
const MAX_CONTEXT_FILE_SIZE = 10 * 1024;

/**
 * Context file patterns to look for in working directory (in priority order).
 * Matching is case-insensitive to support AGENTS.md, Agents.md, agents.md, etc.
 */
const CONTEXT_FILE_PATTERNS = ['agents.md', 'claude.md'];
const PROJECT_CONTEXT_FILES_TAGS = ['project_context_files'] as const;
const WORKING_DIRECTORY_TAGS = ['working_directory', 'working_directory_context'] as const;

/**
 * Find a file in directory matching the pattern case-insensitively.
 * Returns the actual filename if found, null otherwise.
 */
function findFileCaseInsensitive(directory: string, pattern: string): string | null {
  try {
    const files = readdirSync(directory);
    const lowerPattern = pattern.toLowerCase();
    return files.find((f) => f.toLowerCase() === lowerPattern) ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the project context file (AGENTS.md or CLAUDE.md) from a directory.
 * Matching is case-insensitive to support any casing (CLAUDE.md, claude.md, Claude.md, etc.).
 * Returns the content if found, null otherwise.
 */
export function readProjectContextFile(directory: string): { filename: string; content: string } | null {
  for (const pattern of CONTEXT_FILE_PATTERNS) {
    // Find the actual filename with case-insensitive matching
    const actualFilename = findFileCaseInsensitive(directory, pattern);
    if (!actualFilename) continue;

    const filePath = join(directory, actualFilename);
    try {
      const content = readFileSync(filePath, 'utf-8');
      // Cap at max size to avoid huge prompts
      if (content.length > MAX_CONTEXT_FILE_SIZE) {
        debug(`[readProjectContextFile] ${actualFilename} exceeds max size, truncating`);
        return {
          filename: actualFilename,
          content: content.slice(0, MAX_CONTEXT_FILE_SIZE) + '\n\n... (truncated)',
        };
      }
      debug(`[readProjectContextFile] Found ${actualFilename} (${content.length} chars)`);
      return { filename: actualFilename, content };
    } catch (error) {
      debug(`[readProjectContextFile] Error reading ${actualFilename}:`, error);
      // Continue to next pattern
    }
  }
  return null;
}

function isSameOrChildPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

type ProjectContextDirectoryLabel = 'context root' | 'repository root' | 'parent context' | 'working directory';

/**
 * Directories whose context files apply to the selected working directory, root first:
 * every folder from the base down to the selection. The base is whichever of the context
 * root (when the selection is inside it) and the selection's git repository root encloses
 * the other, else the selection itself; a context root the selection lies outside of is
 * still listed in front.
 */
function getProjectContextSearchDirectories(
  workingDirectory: string,
  contextRootPath?: string,
): Array<{ directory: string; label: ProjectContextDirectoryLabel }> {
  const selectedDir = resolve(workingDirectory);
  const rootDir = contextRootPath ? resolve(contextRootPath) : undefined;
  const gitRoot = findGitRepositoryRoot(selectedDir) ?? undefined;
  const rootEnclosesSelection = rootDir !== undefined && isSameOrChildPath(rootDir, selectedDir);
  const directories: Array<{ directory: string; label: ProjectContextDirectoryLabel }> = [];

  if (rootDir && !rootEnclosesSelection) {
    directories.push({ directory: rootDir, label: 'context root' });
  }

  let baseDir = selectedDir;
  for (const boundary of [rootEnclosesSelection ? rootDir : undefined, gitRoot]) {
    if (boundary && isSameOrChildPath(boundary, baseDir)) baseDir = boundary;
  }

  const chain: string[] = [];
  for (let dir = selectedDir; ; dir = dirname(dir)) {
    chain.unshift(dir);
    if (dir === baseDir || dirname(dir) === dir) break;
  }

  for (const directory of chain) {
    const label: ProjectContextDirectoryLabel = directory === selectedDir
      ? 'working directory'
      : directory === rootDir
        ? 'context root'
        : directory === gitRoot
          ? 'repository root'
          : 'parent context';
    directories.push({ directory, label });
  }
  return directories;
}

/**
 * The context files of one directory, AGENTS.md first, from a single directory read.
 * When the engine reads this directory and loads its CLAUDE.md itself, that file is left
 * out, and so is an AGENTS.md that is the same file. The engine opens the exact name
 * CLAUDE.md, so on a case-sensitive file system a claude.md is not loaded and stays
 * listed. A CLAUDE.md that is the same file as the AGENTS.md beside it is listed once.
 */
function findContextFilesInDirectory(directory: string, engineReadsDirectory: boolean): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  const agentsFile = entries.find((name) => name.toLowerCase() === 'agents.md');
  const claudeFile = entries.find((name) => name.toLowerCase() === 'claude.md');
  const engineLoadsClaudeFile = engineReadsDirectory && claudeFile !== undefined &&
    (claudeFile === 'CLAUDE.md' || isSameFile(join(directory, claudeFile), join(directory, 'CLAUDE.md')));
  if (agentsFile && claudeFile && isSameFile(join(directory, agentsFile), join(directory, claudeFile))) {
    return engineLoadsClaudeFile ? [] : [agentsFile];
  }

  const files: string[] = [];
  if (agentsFile) files.push(agentsFile);
  if (claudeFile && !engineLoadsClaudeFile) files.push(claudeFile);
  return files;
}

/**
 * Whether two paths open the same file: through links, and through a case alias on a
 * case-insensitive file system. Compares device and inode, since Node's realpathSync
 * keeps the casing it was given while Bun's returns the casing on disk.
 */
function isSameFile(a: string, b: string): boolean {
  try {
    const statA = statSync(a, { bigint: true });
    const statB = statSync(b, { bigint: true });
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch {
    return false;
  }
}

/**
 * The workspace's default working directory, used as the context root. The workspace
 * root itself is Craft's storage folder, never a project, so it is not a fallback.
 */
function getProjectContextRootDirectory(workspaceRootPath?: string): string | undefined {
  if (!workspaceRootPath) {
    return undefined;
  }

  return loadWorkspaceConfig(workspaceRootPath)?.defaults?.workingDirectory || undefined;
}

/**
 * Get the working directory context string for injection into user messages.
 * Includes the working directory path and context about what it represents.
 * Returns empty string if no working directory is set.
 *
 * Note: Project context files (CLAUDE.md, AGENTS.md) are now listed in the system prompt
 * via getProjectContextFilesPrompt() for persistence across compaction.
 *
 * @param workingDirectory - The effective working directory path (where user wants to work)
 * @param isSessionRoot - If true, this is the session folder (not a user-specified project)
 * @param bashCwd - The actual bash shell cwd (may differ if working directory changed mid-session)
 */
export function getWorkingDirectoryContext(
  workingDirectory?: string,
  isSessionRoot?: boolean,
  bashCwd?: string
): string {
  if (!workingDirectory) {
    return '';
  }

  const parts: string[] = [];
  const safeWorkingDirectory = sanitizePromptLine(workingDirectory, WORKING_DIRECTORY_TAGS);
  parts.push(`<working_directory>${safeWorkingDirectory}</working_directory>`);

  if (isSessionRoot) {
    // Add context explaining this is the session folder, not a code project
    parts.push(`<working_directory_context>
This is the session's root folder (default). It contains session files (conversation history, plans, attachments) - not a code repository.
You can access any files the user attaches here. If the user wants to work with a code project, they can set a working directory via the UI or provide files directly.
</working_directory_context>`);
  } else {
    // Check if bash cwd differs from working directory (changed mid-session)
    // Only show mismatch warning when bashCwd is provided and differs
    const hasMismatch = bashCwd && bashCwd !== workingDirectory;

    if (hasMismatch) {
      // Working directory was changed mid-session - bash still runs from original location
      parts.push(`<working_directory_context>The user explicitly selected this as the working directory for this session.

Note: The bash shell runs from a different directory (${sanitizePromptLine(bashCwd, WORKING_DIRECTORY_TAGS)}) because the working directory was changed mid-session. Use absolute paths when running bash commands to ensure they target the correct location.</working_directory_context>`);
    } else {
      // Normal case - working directory matches bash cwd
      parts.push(`<working_directory_context>The user explicitly selected this as the working directory for this session.</working_directory_context>`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Get the current date/time context string
 */
export function getDateTimeContext(): string {
  const now = new Date();
  const formatted = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  return `**USER'S DATE AND TIME: ${formatted}; ISO: ${now.toISOString()}** - Use this as the current “now” for relative-date reasoning. Do not override explicit dates in the user's message, source data, files, or tool results.`;
}

/** Debug mode configuration for system prompt */
export interface DebugModeConfig {
  enabled: boolean;
  logFilePath?: string;
}

/**
 * Get the project context files prompt section for the system prompt.
 * Lists the context files (AGENTS.md, CLAUDE.md) of each directory from
 * getProjectContextSearchDirectories() that has them.
 *
 * @param claudeEngineCwd - cwd of a Claude engine that loads CLAUDE.md files itself, from
 *   this folder and every ancestor of it; those files are already in context and left out.
 *   Undefined when nothing loads them (Pi, or the engine's loading turned off).
 * Returns empty string if no working directory or no context files found.
 */
export function getProjectContextFilesPrompt(
  workingDirectory?: string,
  contextRootPath?: string,
  claudeEngineCwd?: string,
): string {
  if (!workingDirectory) {
    return '';
  }

  const engineCwd = claudeEngineCwd ? resolve(claudeEngineCwd) : undefined;
  const fileLines: string[] = [];
  for (const { directory, label } of getProjectContextSearchDirectories(workingDirectory, contextRootPath)) {
    const engineReadsDirectory = engineCwd !== undefined && isSameOrChildPath(directory, engineCwd);
    for (const filename of findContextFilesInDirectory(directory, engineReadsDirectory)) {
      fileLines.push(`- ${sanitizePromptLine(join(directory, filename), PROJECT_CONTEXT_FILES_TAGS)} (${label})`);
    }
  }

  if (fileLines.length === 0) {
    return '';
  }

  return `
<project_context_files working_directory="${escapePromptXmlAttr(workingDirectory)}">
${fileLines.join('\n')}
</project_context_files>`;
}

/** Options for getSystemPrompt */
export interface SystemPromptOptions {
  pinnedPreferencesPrompt?: string;
  debugMode?: DebugModeConfig;
  workspaceRootPath?: string;
  /** Working directory for context file discovery (monorepo support) */
  workingDirectory?: string;
  /** Backend name for "powered by X" text (default: 'Claude Code') */
  backendName?: string;
}

/**
 * System prompt preset types for different agent contexts.
 * - 'default': Full Craft Agent system prompt
 * - 'mini': Focused prompt for quick configuration edits
 */
export type SystemPromptPreset = 'default' | 'mini';

/**
 * Get a focused system prompt for mini agents (quick edit tasks).
 * Optimized for configuration edits with minimal context.
 *
 * @param workspaceRootPath - Root path of the workspace for config file locations
 */
export function getMiniAgentSystemPrompt(workspaceRootPath?: string): string {
  const workspaceContext = workspaceRootPath
    ? `\n## Workspace\nConfig files are in: \`${workspaceRootPath}\`\n- Statuses: \`statuses/config.json\`\n- Labels: \`labels/config.json\`\n- Permissions: \`permissions.json\`\n`
    : '';

  return `You are a focused assistant for quick configuration edits in Craft Agent.

## Your Role
You help users make targeted changes to configuration files. Be concise and efficient.
${workspaceContext}
## Guidelines
- Make the requested change directly
- Before changing labels/statuses/sources/skills/automations/permissions, read the matching local doc in ~/.craft-agent/docs/
- Validate with config_validate after editing
- MCP tool calls require _displayName and _intent metadata
- Respect any session_state permission/path constraints supplied with the user message
- Confirm completion briefly
- Don't add unrequested features or changes
- Keep responses short and to the point
- For math, use $$...$$ delimiters; avoid single $...$ in prose so currency remains plain text

## Available Tools
Use Read, Edit, Write tools for file operations.
Use config_validate to verify changes match the expected schema.
`;
}

/**
 * Get the full system prompt with current date/time and user preferences
 *
 * Note: Safe Mode context is injected via user messages instead of system prompt
 * to preserve prompt caching.
 *
 * @param pinnedPreferencesPrompt - Pre-formatted preferences (for session consistency)
 * @param debugMode - Debug mode configuration
 * @param workspaceRootPath - Root path of the workspace
 * @param workingDirectory - Working directory for context file discovery
 * @param preset - System prompt preset ('default' | 'mini' | custom string)
 * @param backendName - Backend name for "powered by X" text (default: 'Claude Code')
 * @param claudeEngineCwd - cwd of a Claude engine that loads CLAUDE.md files itself (see getProjectContextFilesPrompt)
 */
export function getSystemPrompt(
  pinnedPreferencesPrompt?: string,
  debugMode?: DebugModeConfig,
  workspaceRootPath?: string,
  workingDirectory?: string,
  preset?: SystemPromptPreset | string,
  backendName?: string,
  includeCoAuthoredBy?: boolean,
  projectContext?: ProjectPromptContext,
  claudeEngineCwd?: string,
): string {
  // Use mini agent prompt for quick edits (pass workspace root for config paths)
  if (preset === 'mini') {
    debug('[getSystemPrompt] 🤖 Generating MINI agent system prompt for workspace:', workspaceRootPath);
    return getMiniAgentSystemPrompt(workspaceRootPath);
  }

  // Use pinned preferences if provided (for session consistency after compaction)
  const preferences = pinnedPreferencesPrompt ?? formatPreferencesForPrompt();
  const debugContext = debugMode?.enabled ? formatDebugModeContext(debugMode.logFilePath) : '';

  // Get project context files (lives in system prompt for persistence across compaction).
  // The context root is the configured default working directory; without one the git root of the
  // working directory is used. workspaceRootPath is Craft's storage folder and never a context root.
  const projectContextRootDirectory = getProjectContextRootDirectory(workspaceRootPath);
  const projectContextFiles = getProjectContextFilesPrompt(workingDirectory, projectContextRootDirectory, claudeEngineCwd);

  // Optional workspace-project context (injected after preferences, before debug+context-files)
  const projectBlock = projectContext ? formatProjectContextForPrompt(projectContext) : '';

  // Fall back to the user's current preference when callers don't pin/pass a value,
  // so forgetting the argument can't silently re-enable the co-author trailer (see #576).
  const resolvedIncludeCoAuthoredBy = includeCoAuthoredBy ?? getCoAuthorPreference();

  // Note: Date/time context is now added to user messages instead of system prompt
  // to enable prompt caching. The system prompt stays static and cacheable.
  // Safe Mode context is also in user messages for the same reason.
  const basePrompt = getCraftAssistantPrompt(workspaceRootPath, backendName, resolvedIncludeCoAuthoredBy);
  const fullPrompt = `${basePrompt}${preferences}${projectBlock}${debugContext}${projectContextFiles}`;

  debug('[getSystemPrompt] full prompt length:', fullPrompt.length);

  return fullPrompt;
}

/**
 * Format the project-context block injected into the system prompt.
 *
 * The block is wrapped in an XML-ish element so models can latch onto it as
 * authoritative project metadata without conflating it with user preferences
 * or the monorepo CLAUDE.md context.
 */
/** Block tags whose closing form must not appear inside injected project fields. */
const PROJECT_BLOCK_TAGS = [
  'project_context',
  'project_assets_path',
  'project_assets',
  'project_memory_path',
  'project_memory',
] as const;

/** Sanitize a multi-line body field (description/details/memory) before prompt injection. */
function sanitizeProjectBodyText(content: string): string {
  return sanitizePromptBody(content, PROJECT_BLOCK_TAGS);
}

/** Sanitize a single-line label (asset filename/path/MIME type) before prompt injection. */
function sanitizeProjectLine(name: string): string {
  return sanitizePromptLine(name, PROJECT_BLOCK_TAGS);
}

export function formatProjectContextForPrompt(ctx: ProjectPromptContext): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`<project_context project="${escapePromptXmlAttr(ctx.name)}">`);
  if (ctx.description?.trim()) {
    lines.push(sanitizeProjectBodyText(ctx.description.trim()));
    lines.push('');
  }
  if (ctx.details?.trim()) {
    lines.push(sanitizeProjectBodyText(ctx.details.trim()));
    lines.push('');
  }

  lines.push(`<project_assets_path>${sanitizeProjectBodyText(ctx.assetsPath)}</project_assets_path>`);
  if (ctx.assets.length > 0) {
    lines.push('<project_assets>');
    for (const asset of ctx.assets) {
      lines.push(`- ${sanitizeProjectLine(asset.filename)} (${sanitizeProjectLine(asset.mimeType)}, ${formatBytes(asset.sizeBytes)})`);
    }
    lines.push('</project_assets>');
  }

  lines.push(`<project_memory_path>${sanitizeProjectBodyText(ctx.memoryPath)}</project_memory_path>`);
  if (ctx.memoryContent?.trim()) {
    lines.push('<project_memory>');
    lines.push(sanitizeProjectBodyText(ctx.memoryContent.trim()));
    lines.push('</project_memory>');
  }
  lines.push('');

  lines.push(`The user has bound this session to the project above.`);
  if (ctx.assets.length > 0) {
    lines.push(`<project_assets> lists reference files the user provided. Read a specific file on-demand by`);
    lines.push(`its absolute path (<project_assets_path> + filename) only when it's relevant — you do not need`);
    lines.push(`to read them all.`);
  }
  lines.push(`<project_memory> is authoritative accumulated knowledge for this project; treat it as`);
  lines.push(`established context. When you learn something durable (a decision, gotcha, convention, or`);
  lines.push(`project-specific user preference), record it in MEMORY.md at <project_memory_path> via Write/Edit —`);
  lines.push(`concise, newest/most-important first, kept under ~5000 tokens.`);
  lines.push(`</project_context>`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Format debug mode context for the system prompt.
 * Only included when running in development mode.
 */
function formatDebugModeContext(logFilePath?: string): string {
  if (!logFilePath) {
    return '';
  }

  return `

## Debug Mode

You are running in **debug mode** (development build). Application logs are available for analysis.

### Log Access

- **Log file:** \`${logFilePath}\`
- **Format:** JSON Lines (one JSON object per line)

Each log entry has this structure:
\`\`\`json
{"timestamp":"2025-01-04T10:30:00.000Z","level":"info","scope":"session","message":["Log message here"]}
\`\`\`

### Querying Logs

Use Bash with \`rg\`/\`grep\` to search logs efficiently:

\`\`\`bash
# Search by scope (session, ipc, window, agent, main)
rg -n "session" "${logFilePath}"

# Search by level (error, warn, info)
rg -n '"level":"error"' "${logFilePath}"

# Search for specific keywords
rg -n "OAuth" "${logFilePath}"

# Recent matches (tail)
rg -n "session|OAuth|\"level\":\"error\"" "${logFilePath}" | tail -n 50
\`\`\`

**Tip:** Use \`-C 2\` for context around matches when debugging issues.
`;
}

/**
 * Get the Craft Agent environment marker for SDK JSONL detection.
 * This marker is embedded in the system prompt and allows us to identify
 * Craft Agent sessions when importing from Claude Code.
 */
function getCraftAgentEnvironmentMarker(): string {
  const platform = process.platform; // 'darwin', 'win32', 'linux'
  const arch = process.arch; // 'arm64', 'x64'
  const osVersion = os.release(); // OS kernel version

  return `<craft_agent_environment version="${APP_VERSION}" platform="${platform}" arch="${arch}" os_version="${osVersion}" />`;
}

/**
 * Get the Craft Assistant system prompt with workspace-specific paths.
 *
 * This prompt is intentionally concise - detailed documentation lives in
 * ${APP_ROOT}/docs/ and is read on-demand when topics come up.
 *
 * @param workspaceRootPath - Root path of the workspace
 * @param backendName - Backend name for "powered by X" text (default: 'Claude Code')
 * @param includeCoAuthoredBy - Whether to include the Co-Authored-By git trailer instruction (default: true)
 */
/**
 * Permission modes table and per-mode rules. Guarded is always listed: Claude snapshots the
 * system prompt, so a session switched to Guarded after it started must still find the row.
 * Execute's row always promises no prompts, because Execute never consults the decision model.
 */
export function getPermissionModesSection(): string {
  return `## Permission Modes

| Mode | Description |
|------|-------------|
| **${PERMISSION_MODE_CONFIG['safe'].displayName}** | Read-only exploration. Writes are limited to \`plansFolderPath\` and \`dataFolderPath\`. |
| **${PERMISSION_MODE_CONFIG['ask'].displayName}** | Prompts before edits. Read operations run freely. |
| **${PERMISSION_MODE_CONFIG['guarded'].displayName}** | Autonomous execution; a call the decision model judges risky (hard to undo, outside the project, reaching other people or services) asks the user first. While the decision model is off it behaves like ${PERMISSION_MODE_CONFIG['ask'].displayName}. |
| **${PERMISSION_MODE_CONFIG['allow-all'].displayName}** | Full autonomous execution. No prompts. |

Current mode and writable planning/data folders are in \`<session_state>\`.

If permissionMode is **${PERMISSION_MODE_CONFIG['safe'].displayName}**:
- Read/search freely.
- Write only to the exact \`plansFolderPath\` / \`dataFolderPath\` from \`<session_state>\`.
- For edits outside those folders, write a plan file there, call \`SubmitPlan\`, then stop for user approval.

If permissionMode is **${PERMISSION_MODE_CONFIG['ask'].displayName}**, **${PERMISSION_MODE_CONFIG['guarded'].displayName}** or **${PERMISSION_MODE_CONFIG['allow-all'].displayName}**:
- Proceed according to that mode and the user's latest request.
- Use \`SubmitPlan\` only when the user asks for a plan or the change is broad/risky.

Mode switching is normal. Apply the latest \`<session_state>\` immediately; \`modeChangeUserSignal\` means the user manually changed mode for this turn.

**Path rule:** In Explore mode, do not write to \`.copilot-config/\`, \`session-state/\`, the session root, or arbitrary workspace paths. Use only the exact folders from \`<session_state>\`.`;
}

function getCraftAssistantPrompt(workspaceRootPath?: string, backendName: string = 'Claude Code', includeCoAuthoredBy: boolean = true): string {
  // Default to ${APP_ROOT}/workspaces/{id} if no path provided
  const workspacePath = workspaceRootPath || `${APP_ROOT}/workspaces/{id}`;

  // Resolve actual sources and skills directories (may be custom paths from config)
  const sourcesPath = workspaceRootPath
    ? getWorkspaceSourcesPath(workspaceRootPath)
    : `${workspacePath}/sources`;
  const skillsPath = workspaceRootPath
    ? getWorkspaceSkillsPath(workspaceRootPath)
    : `${workspacePath}/skills`;
  // Extra skill folders (extraSkillDirs), one line each between workspace and global
  const extraSkillLines = (workspaceRootPath ? getWorkspaceExtraSkillsPaths(workspaceRootPath) : [])
    .map(dir => `- Extra: \`${dir}/{slug}/SKILL.md\`\n`)
    .join('');

  // Read the SDK plugin name from .claude-plugin/plugin.json — this is what the SDK
  // uses to resolve skills. Falls back to basename for backwards compatibility.
  const workspaceId = (workspaceRootPath && readPluginName(workspaceRootPath))
    || basename(workspacePath)
    || '{workspaceId}';

  // Environment marker for SDK JSONL detection
  const environmentMarker = getCraftAgentEnvironmentMarker();

  // rtk rewrites Bash commands behind the agent's back; say so, and how to get raw output.
  const rtkActive = getRtkEnabled() && getRtkPath() !== null;

  // Decision layer (Jev): Settings switch + feature toggle, evaluated per prompt build.
  const decideToolActive = isDecisionFeatureActive('decideTool');
  const browserToolsSection = getBrowserToolEnabled() ? `
## Browser Tools

Use \`browser_tool\` for one-off or UI-driven browser tasks, or as a fallback when source setup/API coverage is fragile.

**Before first use in a session:** read \`${DOC_REFS.browserTools}\`. Browser calls are blocked until that guide is read.

Core flow: \`open\` → \`navigate <url>\` → \`snapshot\` → interact by refs (\`click @e1\`, \`fill @e2 value\`, \`select @e3 value\`). Run \`browser_tool --help\` for full command syntax.

Useful commands: \`find\`, \`click-at\`, \`type\`, \`paste\`, \`scroll\`, \`wait\`, \`key\`, \`console\`, \`network\`, \`screenshot --annotated\`, \`window-resize\`, \`downloads\`, \`windows\`, \`focus\`, \`hide\`, \`release\`, \`close\`.

Lifecycle: use \`close\` when done, \`release\` when handing the page to the user, or \`hide\` when you may need the same window later.
` : '';

  return `${environmentMarker}

You are Craft Agent - an AI assistant that helps users connect and work across their data sources through a desktop interface.

**Core capabilities:**
- **Connect external sources** - MCP servers, REST APIs, local filesystems. Users can integrate Linear, GitHub, Craft, custom APIs, and more.
- **Automate workflows** - Combine data from multiple sources to create unique, powerful workflows.
- **Code** - You are powered by ${backendName}, so you can write and execute code (Python, Bash) to manipulate data, call APIs, and automate tasks.

**Product documentation:** The Craft Agents docs live at https://thecraftagents.com/docs — fetch pages with your web tools when you need product or setup guidance.

## External Sources

Sources are external data connections. Each source has:
- \`config.json\` - Connection settings and authentication
- \`guide.md\` - Usage guidelines (read before first use!)

**Using an existing source** (it already appears in \`<sources>\` above):
1. Read its \`config.json\` and \`guide.md\` at \`${sourcesPath}/{slug}/\`
2. If it needs auth, trigger the appropriate auth tool
3. Call its tools directly — do not search the workspace for how to use it

**Creating a new source** (does not exist yet):
1. Read \`${DOC_REFS.sources}\` for the setup workflow
2. Verify current endpoints via web search, and use browser tools when docs are dynamic or login-protected
3. Before full setup, confirm whether in-app browser is a better fit for one-off or UI-only tasks

**Workspace structure:**
- Sources: \`${sourcesPath}/{slug}/\`
- Skills: \`${skillsPath}/{slug}/\`
- Theme: \`${workspacePath}/theme.json\`

## Skills

Skills are reusable instruction sets that teach you specialized behaviors. Each skill has:
- \`SKILL.md\` - Instructions and behavior definition (read before execution!)

**Using a skill** (user mentions it with \`[skill:slug]\`):
1. Read its \`SKILL.md\` at the resolved path using the Read tool or \`cat\` via Bash — tool calls are blocked until it is read
2. Follow the instructions in the file to complete the user's request

Skills are stored at these levels (highest priority first):
- Project: \`{projectRoot}/.agents/skills/{slug}/SKILL.md\`
- Workspace: \`${skillsPath}/{slug}/SKILL.md\`
${extraSkillLines}- Global: \`~/.agents/skills/{slug}/SKILL.md\`

Create new skills in \`${skillsPath}/{slug}/\` unless the user asks for a project or global skill.

## Project Context

When \`<project_context_files>\` appears in the system prompt, it lists the context files (AGENTS.md, CLAUDE.md) that apply to the working directory, root first: from the context root (the workspace default working directory) or the git repository root, whichever encloses the other, down through every folder to the working directory. If the working directory is outside the context root, the context root's files are listed first. CLAUDE.md files already loaded into your context are not listed.

**CRITICAL INSTRUCTION**: Listed files are NOT loaded into your context automatically. You MUST read ALL of them using the Read tool, from root to working directory, before acting (skip one whose contents already appear in your context, e.g. through a CLAUDE.md \`@AGENTS.md\` import), and read a file again when its contents are no longer in your context (e.g. after compaction).
**Subfolders**: When the task moves into a subfolder of the working directory that has its own AGENTS.md (or CLAUDE.md), read that file before working there.
**Priority Rule**: The closest file to the working directory wins. Rules in the working directory override parent rules, and parent rules override root rules.

## Configuration Documentation

| Topic | Documentation | When to Read |
|-------|---------------|--------------|
| Sources | \`${DOC_REFS.sources}\` | BEFORE creating/modifying sources |
| Permissions | \`${DOC_REFS.permissions}\` | BEFORE modifying ${PERMISSION_MODE_CONFIG['safe'].displayName} mode rules |
| Skills | \`${DOC_REFS.skills}\` | BEFORE creating custom skills |
| Automations | \`${DOC_REFS.hooks}\` | BEFORE creating/modifying automations |
| Pages | \`${DOC_REFS.pages}\` | BEFORE creating Pages or authoring page HTML |
| Themes | \`${DOC_REFS.themes}\` | BEFORE customizing colors |
| Statuses | \`${DOC_REFS.statuses}\` | When user mentions statuses or workflow states |
| Labels | \`${DOC_REFS.labels}\` | BEFORE creating/modifying labels |
| Tool Icons | \`${DOC_REFS.toolIcons}\` | BEFORE modifying tool icon mappings |
| Mermaid | \`${DOC_REFS.mermaid}\` | When creating diagrams |
| Data Tables | \`${DOC_REFS.dataTables}\` | When working with datasets of 20+ rows |
| HTML Preview | \`${DOC_REFS.htmlPreview}\` | When rendering HTML content (emails, reports) |
| PDF Preview | \`${DOC_REFS.pdfPreview}\` | When displaying PDF documents inline |
| Image Preview | \`${DOC_REFS.imagePreview}\` | When displaying local image files inline |
| Markdown Preview | \`${DOC_REFS.markdownPreview}\` | When displaying rendered .md files inline |
| Browser Tools | \`${DOC_REFS.browserTools}\` | When using in-app browser tools (\`browser_tool\`) |
| LLM Tool | \`${DOC_REFS.llmTool}\` | When using \`call_llm\` for subtasks |${decideToolActive ? `
| Decision Model | \`${DOC_REFS.decisions}\` | When using \`decide\` to classify, route or score items |` : ''}${FEATURE_FLAGS.craftAgentsCli ? `
| Craft CLI | \`${DOC_REFS.craftCli}\` | When managing labels/sources/skills/automations via \`craft-agent\` |` : ''}

**IMPORTANT:** Always read the relevant doc file BEFORE making changes. Do NOT guess schemas - these have specific patterns that differ from standard approaches.${FEATURE_FLAGS.craftAgentsCli ? `

## Craft Agent CLI

Prefer \`craft-agent\` CLI over direct file edits for labels, sources, skills, and automations.

- Labels help: \`craft-agent label --help\`
- Sources help: \`craft-agent source --help\`
- Skills help: \`craft-agent skill --help\`
- Automations help: \`craft-agent automation --help\`
- Canonical reference: \`${DOC_REFS.craftCli}\`` : ''}

## User preferences

You can store and update user preferences using the \`update_user_preferences\` tool. 
When you learn information about the user (their name, timezone, location, language preference, or other relevant context), proactively offer to save it for future conversations.

## Interaction Guidelines

1. **Be Concise**: Provide focused, actionable responses.
2. **Show Progress**: Briefly explain multi-step operations as you perform them.
3. **Confirm Destructive Actions**: Always ask before deleting content.
4. **Use Available Tools**: Only call tools that exist. Check the tool list and use exact names.
5. **Present File Paths, Links As Clickable Markdown Links**: Format file paths and URLs as clickable markdown links for easy access instead of code formatting.
6. **Nice Markdown Formatting**: The user sees your responses rendered in markdown. Use headings, lists, bold/italic text, and code blocks for clarity. Basic HTML is also supported, but use sparingly.
7. **Math Delimiters**: Use \`$$...$$\` for math expressions. Do NOT use single-dollar delimiters (\`$...$\`) in normal prose so currency values like \`$100\` or \`$2M–$4M\` stay plain text.

!!IMPORTANT!!. You must refer to yourself as Craft Agent when asked. You can acknowledge that you are powered by ${backendName}.

${includeCoAuthoredBy ? `## Git Conventions

When creating git commits, include Craft Agent as a co-author:

\`\`\`
Co-Authored-By: Craft Agent <agents-noreply@craft.do>
\`\`\`
` : ''}${getPermissionModesSection()}
${backendName === 'Codex' ? `
### Planning tools (Codex)
- **update_plan** — Live task tracking within a turn/session (statuses: pending/in_progress/completed). Does not pause execution or request approval.
- **SubmitPlan** — User-facing implementation proposal (markdown plan file + approval gate). In Explore mode, required before execution and pauses for user confirmation.

Recommended flow:
1. Start multi-step work with \`update_plan\`.
2. Keep \`update_plan\` updated as steps progress for turncard/tasklist accuracy.
3. When ready to implement (especially in Explore mode), write the plan file and call \`SubmitPlan\`.
4. After acceptance and execution starts, continue using \`update_plan\` for granular progress.

**Writing plan files (Codex):** Create plan files using shell commands. Do NOT use heredocs (\`<<EOF\`) as they are blocked by the sandbox.

Examples (replace \`$PLANS_PATH\` with your actual \`plansFolderPath\` value):

Unix/macOS:
\`\`\`bash
printf '%s\\n' "# Plan Title" "" "## Goal" "Description" "" "## Steps" "1. Step one" > "$PLANS_PATH/my-plan.md"
\`\`\`

Windows (PowerShell) - use single quotes to avoid escaping issues:
\`\`\`powershell
@('# Plan Title', '', '## Goal', 'Description', '', '## Steps', '1. Step one') | Out-File -FilePath '$PLANS_PATH\\my-plan.md' -Encoding utf8
\`\`\`
` : ''}
${backendName === 'Codex' ? `
## MCP Tool Naming

MCP tools from connected sources follow the naming pattern \`mcp__sources__{slug}__{tool}\`:

- **\`slug\`** is the source's **slug** from the \`<sources>\` block above (e.g., \`linear\`, \`github\`)
- Do **NOT** use source IDs, provider names, or config.json \`id\` fields
- Example: Linear source (slug: \`linear\`) → \`mcp__sources__linear__list_issues\`, \`mcp__sources__linear__create_issue\`
- Example: Craft source (slug: \`craft\`) → \`mcp__sources__craft__search_spaces\`, \`mcp__sources__craft__get_block\`
- The \`session\` MCP server provides workspace tools: \`mcp__session__SubmitPlan\`, \`mcp__session__source_test\`, etc.

**Tool discovery:** Call \`mcp__sources__{slug}__list_tools\` or try calling a specific tool directly — the error response will list available tools.
- **NEVER** use \`list_mcp_resources\` — it lists resources, not tools. It will not help you discover available tools.
- **NEVER** use shell/bash to call MCP tools. MCP tools are first-class functions you call directly, just like \`exec_command\` or \`apply_patch\`.

**After OAuth completes:** MCP tools become available on the next turn. If tools were not available before auth, try calling them directly now — they will work after authentication. Do NOT keep running \`source_test\` to check — just call the tools.

## Source Management Tools

The \`session\` MCP server provides tools for managing external sources:

| Tool | Purpose |
|------|---------|
| \`source_test\` | Validate config, test connection, check auth status |
| \`source_oauth_trigger\` | Start OAuth for MCP sources (Linear, Notion, etc.) |
| \`source_google_oauth_trigger\` | Google OAuth (Gmail, Calendar, Drive, Docs, Sheets, YouTube, Search Console) |
| \`source_slack_oauth_trigger\` | Slack OAuth |
| \`source_microsoft_oauth_trigger\` | Microsoft OAuth (Outlook, Teams, OneDrive) |
| \`source_credential_prompt\` | Prompt user for API key / bearer token |

**Source creation workflow:**
1. Read \`${DOC_REFS.sources}\` for the full setup guide
2. Check the product docs (https://thecraftagents.com/docs) for service-specific guides
3. Create \`config.json\` in \`sources/{slug}/\`
4. Create \`permissions.json\` for Explore mode
5. Write \`guide.md\` with usage instructions
6. Run \`source_test\` to validate — **once only, before auth**
7. Trigger the appropriate auth tool

**STRICT RULES:**
- Run \`source_test\` at most **ONCE** per source. It validates config structure only. Repeating it gives the same result.
- When a user asks you to call a specific tool, call **THAT tool and nothing else**. Do not run \`source_test\` or other tools instead.
- **Do NOT** grep the workspace, search session files, or do web searches to find source config patterns. Read the source's \`config.json\` and \`guide.md\` directly.
- **If an existing source is already configured**, read its \`config.json\` + \`guide.md\`, then use it. Do not recreate or search for how to set it up.

**If MCP connection fails after OAuth with "Auth required":** The source needs to be re-enabled in the session for the new credentials to take effect. Do NOT keep retrying the same failing call or investigating log files — ask the user to re-enable the source or restart the session.
` : ''}
**Full reference on what commands are enabled:** \`${DOC_REFS.permissions}\` (bash command lists, blocked constructs, planning workflow, customization). Read if unsure, or user has questions about permissions.

## Web Search

You have access to web search for up-to-date information. Use it proactively to get up-to-date information and best practices.
Your memory is limited by its cut-off date, so it can be wrong, stale, or incomplete for fast-changing topics like technology, current events, and recent developments.
I.e. there is now iOS/MacOS26, it's 2026, the world has changed a lot since your training data!

## Code Diffs and Visualization
You can render **unified code diffs natively** as beautiful diff views. Use diffs where it makes sense to show changes. Users will love it.

## Structured Data (Tables & Spreadsheets)

Use native \`datatable\` / \`spreadsheet\` fenced blocks for structured results the user may sort, filter, or export.

- \`datatable\`: API/query results, comparisons, sortable/filterable lists.
- \`spreadsheet\`: financial/report-style grids or export-oriented data.
- Markdown tables: only for tiny/simple data.
- 20+ rows: read \`${DOC_REFS.dataTables}\`, use \`transform_data\`, and reference the absolute output path via \`"src"\` instead of inlining rows.

Column types: \`text\`, \`number\`, \`currency\`, \`percent\`, \`boolean\`, \`date\`, \`badge\`. Currency/percent values should be raw numbers, not formatted strings.

Reference: \`${DOC_REFS.dataTables}\`

## LLM Tool (\`call_llm\`)

Use \`call_llm\` for focused single-completion subtasks: batch summarization/classification, structured extraction with \`outputSchema\`, cheap isolated analysis, or deep reasoning on a bounded input.

Do **not** use it when you can answer directly, when it needs conversation history, or for trivial one-liners. The subtask needs file/shell tools (for example, Read or Bash) → use the appropriate tools in the main agent instead.

For large batches, call multiple \`call_llm\` invocations in parallel. Pass existing file paths as attachments; put inline text in the prompt.

Reference: \`${DOC_REFS.llmTool}\`
${decideToolActive ? `
## Decision Model (\`decide\`)

Use \`decide\` for typed judgments over text or JSON: classify, route, score or yes/no-check one item or a batch of up to 200 (\`items\`). It answers with probabilities and confidence, never text. Prefer it over \`call_llm\` when the answer is one of a fixed set of options; use \`call_llm\` when you need generated text or extracted values.

Rules: confidence below 0.5 means "unsure" — report it or ask instead of guessing. An answer is never permission: re-check before acting on it. The state is sent to the user's configured decision provider, so keep secrets out of it.

Reference: \`${DOC_REFS.decisions}\`
` : ''}${browserToolsSection}
## Session Self-Management

Use session tools to inspect or update Craft Agent sessions/tasks:

- \`get_session_info\`: inspect current or target session metadata.
- \`set_session_labels\`: replace labels; valued labels use \`id::value\` and must match the configured type.
- \`set_session_status\`: set an open workflow status. Never move work into closed statuses such as \`done\`/\`cancelled\`; use \`needs-review\` when ready.
- \`list_sessions\`: query with filters first; then call \`get_session_info\` for details.
- \`list_background_tasks\`: the authoritative status source for background work. Report exactly what it returns.
- \`send_agent_message\`: coordinate with another session; queued means not read yet.
- \`create_task\`: create a board task in \`todo\` only. Do not run it unless separately requested/automated.
- \`archive_session\`: archive another idle session by explicit ID only.

Setting labels/statuses can trigger automations. Do not guess task closure or background-task outcomes.

## Automations

Automations run prompts, webhooks, or workspace-local scripts from configured triggers/schedules.

Rules:
- Read \`${DOC_REFS.hooks}\` before creating or modifying automations.
- Prefer CLI/config validation over guessing schemas.
- Automation-created sessions and tasks should remain reviewable; do not close tasks yourself.
- Script actions run workspace-local scripts, not arbitrary shell snippets.
- Use labels/statuses intentionally because changes can trigger automation events.

Reference: \`${DOC_REFS.hooks}\`

## Pages

Pages are persistent HTML mini apps/reports in the app's Pages sidebar. Use them for dashboards, reports, trackers, or tools the user will revisit/share; use chat previews for one-off inline rendering.

Tools: \`list_pages\`, \`get_page\`, \`create_page\`, \`update_page\`, \`write_page_data\`, \`delete_page\`.

Rules:
- Read \`${DOC_REFS.pages}\` before creating/updating Pages or authoring page HTML.
- Do not edit \`pages/{slug}/\` files directly; use Page tools so digests/watchers/UI stay consistent.
- Full standalone HTML only: inline CSS/JS, no external network requests.
- Live/interactive pages receive data through the \`craft-pages/v1\` bridge documented in the guide.
- Pages never hold credentials; source actions require user-approved grants.
- Confirm before \`delete_page\`. Publishing/sharing is the user's action.

Reference: \`${DOC_REFS.pages}\`

## Diagrams and Visualization

Prefer Mermaid over ASCII for architecture, data flow, state, sequence, class, ER, and simple chart visuals.

Guidelines:
- Keep one concept per diagram; split large diagrams.
- Use horizontal layout for small diagrams and vertical/focused diagrams for larger ones.
- Validate complex diagrams with \`mermaid_validate\` before output.
- Use unified diffs when showing code changes.

Reference: \`${DOC_REFS.mermaid}\`

## Preview Blocks

Use preview fences when rendering local files inline instead of dumping raw content:

- \`html-preview\`: rich HTML emails/reports. Write/decode content to an HTML file first.
- \`pdf-preview\`: PDFs already on disk or downloaded/generated PDFs.
- \`image-preview\`: screenshots and local images.
- \`markdown-preview\`: rendered \`.md\` files, especially plans/specs you wrote.

Each preview supports either \`"src": "/absolute/path"\` or an \`items\` array for tabs. Use absolute paths returned by tools. For detailed syntax, read the matching guide: \`${DOC_REFS.htmlPreview}\`, \`${DOC_REFS.pdfPreview}\`, \`${DOC_REFS.imagePreview}\`, \`${DOC_REFS.markdownPreview}\`.

## Document Tools

Built-in document CLIs are available via Bash: \`markitdown\`, \`pdf-tool\`, \`xlsx-tool\`, \`docx-tool\`, \`pptx-tool\`, \`img-tool\`, \`doc-diff\`, \`ical-tool\`.

Prefer \`markitdown\` as the universal converter when Read cannot handle a binary document. All tools support \`--help\`; most support \`-o <file>\` for output.
${rtkActive ? `
Bash output of common commands (grep, ls, git, test runners) is compacted by rtk: lines may be grouped, trimmed or summarized. When you need exact output, prefix the command with \`command\` or run the binary by path (\`/usr/bin/grep\`).
` : ''}
## Tool Metadata

All MCP tools require two metadata fields (schema-enforced):

- **\`_displayName\`** (required): Short name for the action (2-4 words), e.g., "List Folders", "Search Documents"
- **\`_intent\`** (required): Brief description of what you're trying to accomplish (1-2 sentences)

These help with UI feedback and result summarization.${FEATURE_FLAGS.developerFeedback ? `

## Developer Feedback

You have a \`send_developer_feedback\` tool — a direct line to the Craft Agent development team.

**Share freely — issues, ideas, suggestions, anything:**
- Tools returning wrong results, missing data, confusing behavior
- Ideas for new tools, better defaults, improved workflows
- Patterns you notice that could be automated or simplified
- Things that slow you down or make it harder to help the user

**Write detailed markdown.** Use headings, bullet lists, code blocks. Include what happened, what you expected, and what would help. The more context the better — developers will read these to understand how to make you more effective.

**Skip it for:** one-off user errors or issues clearly outside the product's control.` : ''}`;
}

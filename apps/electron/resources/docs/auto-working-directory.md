# Auto Working Directory

A new session's first message can move the session to the project folder it is about, before the agent starts, so
that project's `AGENTS.md`/`CLAUDE.md` and the shell's folder are right from the first turn.

- With the switch on, a new chat starts in the workspace's default working directory (the "root"), never in a folder
  remembered from an earlier session. Its first message then picks from the root: a listed folder, a task folder
  inside it, or the folder the latest chat worked in. Unsure means the root.
- It never runs once the user picks a folder below the root. Picking the root itself (or Reset) leaves it on.
- It never touches tasks, their subtasks, kanban tiles, automations, branches or sessions opened for a project.

Read this before adding, changing or removing folders on that list, or turning the feature on or off.

## Where it lives

The workspace's `config.json` (its path is under **Workspace structure** in your system prompt, as "Workspace
settings"). Two top-level keys:

| Key | Type | Meaning |
|-----|------|---------|
| `autoWorkingDirectory` | boolean | `true` turns the feature on for this workspace. Remove the key (or set `false`) to turn it off. A string such as `"true"` does **not** count. |
| `autoWorkingDirectoryFolders` | array of strings | The folder list, one line per string. Remove the key when the list is empty. |

The folder paths are relative to `defaults.workingDirectory` in the same file (the "root"). Without
`defaults.workingDirectory` the feature does nothing; ask the user to set it in Workspace Settings first.

```json
{
  "defaults": { "workingDirectory": "/Users/me/work" },
  "autoWorkingDirectory": true,
  "autoWorkingDirectoryFolders": [
    "# Projects a first message may move to",
    "projects/acme-api (acme, storefront): Acme API: pricing, endpoints, API keys",
    "projects/garden: garden plans, planting calendar, watering"
  ]
}
```

## Line format

`<folder path relative to the root> (<alias>, <alias>): <when to pick this folder>`

- The path comes before the first `:`, so a folder name may not contain `:`. Write it with `/`, no leading `./`, no
  trailing `/`.
- Aliases are optional: other names the user calls the project by, in parentheses after the path, separated by commas.
  An alias may not contain `:`, `(`, `)` or `,`, and a folder whose name ends in `)` cannot be listed.
- Not allowed: absolute paths, `~`, `..` that leaves the root, the root itself. The folder must exist.
- One line per folder, no duplicates, at most 200 folders (later lines are ignored).
- Blank lines and lines starting with `#` are skipped (use them as comments or headings).

## Writing the notes

The note is what the model reads to decide, so keep it short and specific: what the project is, its topics, and the
words the user would use for it, in the user's own language. A listed folder's `AGENTS.md`/`CLAUDE.md` description is
added to the note automatically, so do not copy it.

A folder's name or one of its aliases in a message (4+ characters, whole word, any case) moves the session there
without asking a model, so short, distinctive names help. Aliases match with their accents as written: add an
unaccented alias too if the user types without accents. Aliases under 4 characters are only read by the model. Words in
a note never count that way.

## Task folders and the last folder

These need no list entries:

- **Task folders.** Once a listed folder is picked, the session goes into one of its direct subfolders when the message
  shares at least two words with that subfolder's name (and no other subfolder as many). Words of the project's own name,
  numbers such as dates and words under 3 characters do not count; subfolders starting with `.` or `_` and listed
  folders are skipped. Example: in `projects/acme`, "the lan dashboard" picks `241101-acme-build-lan-dashboard`.
- **The last folder.** The folder the workspace's latest chat worked in (inside the root, not the root) is offered to the
  model for a message that continues earlier work ("continue", "keep going"). Tasks, automations and hidden sessions do
  not count as chats.

## Changing the list

1. Read `config.json` and note `defaults.workingDirectory`.
2. To find projects, look through the root's folders: a folder with an `AGENTS.md` or `CLAUDE.md` is usually a project.
   Read that file to write the note.
3. Check that every folder you add exists (`ls <root>/<path>`).
4. Edit only `autoWorkingDirectory` and `autoWorkingDirectoryFolders`. Keep every line the user did not ask to change,
   in order, keep the JSON valid, and change no other field.
5. Tell the user which lines you added, changed or removed, and whether the feature is on.

Lines that name no usable folder are listed under the box in **Workspace Settings → Auto working directory**, where
the user can also edit the list and flip the switch.

## Which model picks

A path in the message, or a listed folder's name or alias, decides first. Otherwise the decision model (Jev) picks
when it is on in Settings → AI; else the small model of the session's connection does (one short call, at most 8
seconds). Only the message, attachment names, the notes and paths relative to the root are sent, never absolute paths.

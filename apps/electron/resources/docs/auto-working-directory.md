# Auto Working Directory

A new session's first message can move the session to the project folder it is about, before the agent starts, so
that project's `AGENTS.md`/`CLAUDE.md` and the shell's folder are right from the first turn. It only picks among the
folders the workspace lists, and only while the session is still in the workspace's default working directory (or a
folder remembered from an earlier session). It never runs after the user picks a folder, and it stays put when unsure.

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
    "projects/acme-api: Acme API: pricing, endpoints, API keys",
    "projects/garden: garden plans, planting calendar, watering"
  ]
}
```

## Line format

`<folder path relative to the root>: <when to pick this folder>`

- The path comes before the first `:`, so a folder name may not contain `:`. Write it with `/`, no leading `./`, no
  trailing `/`.
- Not allowed: absolute paths, `~`, `..` that leaves the root, the root itself. The folder must exist.
- One line per folder, no duplicates, at most 200 folders (later lines are ignored).
- Blank lines and lines starting with `#` are skipped (use them as comments or headings).

## Writing the notes

The note is what the model reads to decide, so keep it short and specific: what the project is, its topics, and the
words the user would use for it, in the user's own language. A listed folder's `AGENTS.md`/`CLAUDE.md` description is
added to the note automatically, so do not copy it.

A folder's name in a message (4+ characters, whole word) moves the session there without asking a model, so short,
distinctive folder names help. Words in a note never count that way.

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

A path in the message, or a listed folder's name, decides first. Otherwise the decision model (Jev) picks when it is
on in Settings → AI; else the small model of the session's connection does (one short call, at most 8 seconds). Only
the message, attachment names, the notes and paths relative to the root are sent, never absolute paths.

# @agy-daddy/plugin-sidebar

Zero-patch Antigravity Desktop sidebar organizer plugin (`agy-daddy.sidebar`).

## Features

- **Isolated Shadow DOM Mounting**: Runs in `world: "isolated"` on `sidebar.root`, leaving `app.asar` untouched and protecting workspace/branch names from DOM translation walkers.
- **4-Layer Organization Tree**: Custom project groups (create, rename, non-empty delete confirmation, collapse persistence), projects, Git multi-worktree subgroups (zero extra nesting for single-repo projects), and sandboxed sessions.
- **Drag-and-Drop & Menu Fallback**: Zone-strict reordering (`pinned` vs `normal`), cross-group project movement, 600ms hover auto-expand on collapsed groups/projects, and rejection of cross-worktree session drops.
- **Worktree Session Sandboxing**: Binds `StartCascade` `workspaceUris` to the target worktree, shows honest cross-workspace guidance when the native window points elsewhere, and supports opening the worktree in a new window or PC-Web.
- **Enhanced ⇄ Native Toggle & Silent Fallback**: Non-destructive CSS view switching with a persistent topbar toggle and automatic silent fallback to the native sidebar if `sidebar.root` is unavailable.

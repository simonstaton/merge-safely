// @merge-safely/workspace-local — Local git checkout workspace adapter

export { currentTreeWorkspace, WORKTREE_SHA } from "./current.js";
export { type GitOptions, type GitResult, git, scrubSecrets } from "./git.js";
export { type LocalWorkspaceOptions, localWorkspace } from "./local.js";

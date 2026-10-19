// @merge-safely/testkit — Fake providers, sources and fixtures for testing pipelines built on merge-safely

export {
  type DiffResult,
  diffFromFiles,
  type FileContents,
  hunksFor,
  type ParsedFileDiff,
  type ParsedHunk,
  parseUnifiedDiff,
} from "./diff.js";
export { type SampleFixture, sampleFixtures } from "./fixtures.js";
export {
  type FixedClock,
  fixedClock,
  type MemoryEscalation,
  type MemoryMetrics,
  type MemoryReporter,
  type MemoryTrust,
  memoryEscalation,
  memoryMetrics,
  memoryReporter,
  memoryTrust,
  type SilentLogger,
  silentLogger,
} from "./memory.js";
export {
  confirmAll,
  DEFAULT_TOKENS,
  FALLBACK_USD,
  type FakeCall,
  type FakeProvider,
  type FakeProviderOptions,
  fakeModel,
  fakeProvider,
  fakeUsd,
  isJudgeOutput,
  isReviewerOutput,
  passingAudit,
  passOutput,
  type Script,
  type ScriptResult,
} from "./provider.js";
export {
  type HunterBehaviour,
  type JudgeBehaviour,
  type ScriptedRunsSpec,
  sampleBlocker,
  scenarios,
  scriptedRuns,
} from "./scripted.js";
export {
  changeRef,
  DEFAULT_REPO,
  type FakeSource,
  fakeSha,
  fakeSource,
  makeChange,
  makeFile,
  type SourceCall,
  type SourceFixture,
} from "./source.js";
export {
  type FakeWorkspace,
  type FakeWorkspaceHandle,
  type FakeWorkspaceOptions,
  fakeWorkspace,
} from "./workspace.js";

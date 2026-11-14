// Providers consume attachment normalization and executable resolution through
// this barrel rather than depending on the shared module's implementation files.
export { appendFilesInputTag, buildClaudeUserContent, buildCodexInputItems, normalizeImageDescriptors } from './image-attachments.js';
export { resolveClaudeCodeExecutablePath } from './claude-cli-path.js';
export {
  AppError, FORBIDDEN_WORKSPACE_PATHS, WORKSPACES_ROOT, WORKSPACE_ROOTS,
  createCompleteMessage, createNormalizedMessage, errorMessage, normalizeProjectPath,
  parseIncomingJsonObject, stripAnsiSequences,
  SIDE_CONVERSATION_BOUNDARY_PROMPT, SIDE_CONVERSATION_DEVELOPER_INSTRUCTIONS,
  SIDE_QUESTION_ANSWER_SEPARATOR,
  resolvePathUnderRoots, resolveReadOnlyRootPath, validateWorkspacePath,
} from './utils.js';
export type {
  AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter,
  BackgroundTaskSummary, ProviderModelsDefinition, NormalizedMessage,
  SideQuestionOutcome, SideQuestionRequest, SideQuestionSink,
  CreateProjectPathResult, ProjectRepositoryRow, WorkspacePathValidationResult,
  FileTreeDirectoryEntry, FileTreeFileSystem, FileTreeLogger, FileTreeNode,
  FileTreeProjectGateway, FileTreeServiceDependencies, FileTreeServices,
  FileTreeStats, FileTreeUploadedFile, FileTreeWorkspaceGateway,
} from './types.js';

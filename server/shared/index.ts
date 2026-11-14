export { appendFilesInputTag, buildCodexInputItems, normalizeImageDescriptors } from './image-attachments.js';
export { createCompleteMessage, createNormalizedMessage } from './utils.js';
export type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from './types.js';

// Provider synchronizers use these shared helpers to parse transcript metadata
// and normalize imported session names through the shared module's public API.
export { AppError, extractFirstValidJsonlData, findFilesRecursivelyCreatedAfter, normalizeProjectPath, normalizeSessionName, readFileTimestamps, sliceTailPage } from './utils.js';
export type { IProviderSessionSynchronizer } from './interfaces.js';
export type { BackgroundTaskSummary, FetchHistoryOptions, FetchHistoryResult, LLMProvider, NormalizedMessage, SessionForkAncestor, WorkflowAgentActivity } from './types.js';

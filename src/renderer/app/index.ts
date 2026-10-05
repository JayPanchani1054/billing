/**
 * Shell API for feature modules — import everything from here:
 *
 *   import { Screen, ReportScreen, useNav, useApiQuery, useApiMutation, useWorkingDate } from '../../app/index.ts';
 *
 * See src/renderer/app/README.md for usage and conventions.
 */

// Module contract
export type { MenuItem, MenuSection, ModuleDef, ScreenDef, ScreenProps } from './registry.ts';
export { WELL_KNOWN_SCREENS } from './wellKnown.ts';

// API
export { api, apiOptional, isMissingRoute, ApiError } from './api.ts';
export type { ApiArgs, ApiInput, ApiOutput, RouteName } from './api.ts';
export { useApiQuery } from './hooks/useApiQuery.ts';
export type { ApiQueryResult, UseApiQueryOptions } from './hooks/useApiQuery.ts';
export { useApiMutation } from './hooks/useApiMutation.ts';
export type { ApiMutation, UseApiMutationOptions } from './hooks/useApiMutation.ts';
export { useNative } from './hooks/useNative.ts';
export type { NativeCall } from './hooks/useNative.ts';
export { invalidate, clearQueryCache } from './queryClient.ts';
export { native, onBridgeEvent, hasBridge } from './bridge.ts';
export { confirmationOf, errorDetailsText, fieldErrorsOf, isApiError, nestedFieldErrors, userMessage } from './lib/apiErrors.ts';
export type { ClientErrorCode, ConfirmationRequest } from './lib/apiErrors.ts';

// Confirmations
export { confirmDialog, useConfirm, withConfirmation } from './confirm.tsx';
export type { ConfirmOptions } from './confirm.tsx';

// App state & permissions
export { useAppState, useCan, useCompany, useCompanyConfig, useFeatures, useSession } from './state.tsx';
export type { AppPhase, AppStateValue } from './state.tsx';

// Navigation
export {
  DialogScreen,
  ScreenErrorBoundary,
  useDirty,
  useModules,
  useNav,
  useNavStack,
  useOptionalScreen,
  useScreen,
  useScreenActions,
  useScreenResult,
  useScreenTitle,
  useStatusHint,
} from './nav.tsx';
export type { DialogScreenProps, NavApi, NavEntry, NavParams, ScreenActionItem, ScreenContextValue } from './nav.tsx';

// Working date & period
export { useBooks, usePeriod, useWorkingDate } from './working.tsx';
export type { Period, PeriodApi, WorkingDateApi } from './working.tsx';

// Shell services (voucher hotkeys, Go To, company switch)
export { useShell, VOUCHER_ENTRY_SCREEN } from './shell.tsx';
export type { ShellApi } from './shell.tsx';
export { getGotoProviders, registerGotoProvider } from './lib/goto.ts';
export type { GotoItem, GotoProvider } from './lib/goto.ts';

// Layout patterns
export { ExportDialog, ReadOnlyNotice, ReportScreen, Screen, ScreenError, ScreenSkeleton } from './Screen.tsx';
export type { ReportExportDef, ReportScreenProps, ScreenLayoutProps } from './Screen.tsx';

// Export / print
export { buildPrintHtml, escapeHtml, exportTable, printReport, savePdf, showInFolder, toCsv } from './export.ts';
export type { ExportCell, ExportColumn, ExportColumnKind, ExportFormat, ExportResult, TableExportDef } from './export.ts';

// Display helpers
export * from './display.ts';

// Features catalogue (labels/descriptions of F11 features)
export { FEATURE_CATALOG, featureInfo, featureLabel } from './lib/featureCatalog.ts';

// Keyboard map
export { GLOBAL_SHORTCUTS, reservedGlobalKeys } from './lib/shortcuts.ts';

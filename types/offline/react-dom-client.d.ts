/** OFFLINE TYPE SHIM — subset of @types/react-dom/client 19. */
import type * as React from 'react';
export interface RootOptions {
  identifierPrefix?: string;
  onUncaughtError?: (error: unknown, errorInfo: { componentStack?: string }) => void;
  onCaughtError?: (error: unknown, errorInfo: { componentStack?: string }) => void;
  onRecoverableError?: (error: unknown, errorInfo: { componentStack?: string }) => void;
}
export interface Root {
  render(children: React.ReactNode): void;
  unmount(): void;
}
export function createRoot(container: Element | DocumentFragment, options?: RootOptions): Root;

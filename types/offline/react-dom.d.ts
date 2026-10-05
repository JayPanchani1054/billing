/** OFFLINE TYPE SHIM — subset of @types/react-dom 19. */
import type * as React from 'react';
export function createPortal(children: React.ReactNode, container: Element | DocumentFragment, key?: React.Key | null): React.ReactPortal;
export function flushSync<R>(fn: () => R): R;

/** OFFLINE TYPE SHIM for react/jsx-runtime (see react.d.ts). JSX namespace is global there. */
import type * as React from 'react';
export const Fragment: React.FunctionComponent<{ children?: React.ReactNode }>;
export function jsx(type: unknown, props: unknown, key?: React.Key): React.ReactElement;
export function jsxs(type: unknown, props: unknown, key?: React.Key): React.ReactElement;
export function jsxDEV(type: unknown, props: unknown, key?: React.Key): React.ReactElement;

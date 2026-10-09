/**
 * Is the stacked screen this component belongs to on display? nav.tsx's ScreenHost provides it
 * (false for lower screens kept mounted but hidden). Outside any screen it is true. useApiQuery
 * reads it so hidden screens don't refetch until they are shown again (lib/queryVisibility.ts).
 * Kept in its own module so the data hooks don't import the navigation stack.
 */
import { createContext } from 'react';

export const ScreenVisibilityContext = createContext<boolean>(true);

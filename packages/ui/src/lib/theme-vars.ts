import * as React from 'react';

/**
 * Every CSS variable the ThemeProviders above have set, the nearest one's winning.
 *
 * ThemeProvider paints the tenant's colours as custom properties on a wrapper element, and
 * CSS hands them down through the DOM, not through React. An overlay portalled to <body>
 * leaves that wrapper, so without these it would draw the storefront's sheets in the
 * platform's default orange. Portal re-applies them on its own wrapper.
 *
 * Internal to this package on purpose: nothing outside it should need to read the theme as
 * raw variables, and not exporting it keeps it that way.
 */
export const ThemeVarsContext = React.createContext<Readonly<Record<string, string>>>({});

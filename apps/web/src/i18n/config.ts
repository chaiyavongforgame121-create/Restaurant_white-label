// The interface languages and this app's cookie. The lists themselves live in @favornoms/shared so
// the three apps cannot drift apart.
import { UI_LOCALE_COOKIE } from '@favornoms/shared';

export {
  UI_LOCALES as locales,
  DEFAULT_UI_LOCALE as defaultLocale,
  UI_LOCALE_NAMES as localeNames,
  type UiLocale as Locale,
} from '@favornoms/shared';

export const LOCALE_COOKIE = UI_LOCALE_COOKIE.web;

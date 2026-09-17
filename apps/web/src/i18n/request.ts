import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { isUiLocale, negotiateUiLocale } from '@favornoms/shared';
import { LOCALE_COOKIE } from './config';
import { messagesFor } from './messages';

// The language someone picked in this app, else the one their browser asks for, else English.
// Chrome only: menu items, ingredients and restaurant names are shown as the merchant typed them.
export default getRequestConfig(async () => {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isUiLocale(chosen)
    ? chosen
    : negotiateUiLocale((await headers()).get('accept-language'));

  return {
    locale,
    messages: messagesFor(locale),
    // English sits under every language already, so a miss here means a key used in code that
    // is not in the English catalogue. Log it while developing; never take a page down for it.
    onError(error) {
      if (process.env.NODE_ENV !== 'production') console.error(error);
    },
    getMessageFallback({ namespace, key }) {
      return [namespace, key].filter(Boolean).join('.');
    },
  };
});

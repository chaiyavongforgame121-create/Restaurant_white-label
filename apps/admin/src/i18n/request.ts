import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, type Locale, locales } from './config';

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const stored = cookieStore.get('NEXT_LOCALE')?.value as Locale | undefined;
  const locale: Locale = stored && locales.includes(stored) ? stored : defaultLocale;
  const messages = (await import(`../../messages/${locale}.json`)).default;
  return { locale, messages };
});

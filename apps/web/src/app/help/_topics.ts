/**
 * Help center topics: their order, URL slug and questions. The words live in the `help`
 * catalogue, under `topics.<key>.title`, `topics.<key>.intro` and
 * `topics.<key>.faqs.<faq>.q` / `.a`, so every language shows the same topics.
 */
export interface Topic {
  /** URL segment, /help/<slug>. Stable: links and the sitemap point at it. */
  slug: string;
  /** Message key under help.topics. */
  key: string;
  /** Question keys under help.topics.<key>.faqs, in display order. */
  faqs: readonly string[];
}

export const TOPICS: readonly Topic[] = [
  {
    slug: 'placing-an-order',
    key: 'placingAnOrder',
    faqs: ['howToOrder', 'scheduleLater', 'customizeItem', 'kitchenInstructions'],
  },
  {
    slug: 'cancel-or-refund',
    key: 'cancelOrRefund',
    faqs: ['howToCancel', 'refundTime', 'partialRefund'],
  },
  {
    slug: 'delivery-issues',
    key: 'deliveryIssues',
    faqs: ['orderLate', 'wrongAddress', 'coldOrDamaged'],
  },
  {
    slug: 'promos-and-loyalty',
    key: 'promosAndLoyalty',
    faqs: ['loyaltyPoints', 'usePromoCode', 'promoExpired'],
  },
  {
    slug: 'account-and-privacy',
    key: 'accountAndPrivacy',
    faqs: ['signIn', 'downloadData', 'deleteAccount', 'paymentSafety'],
  },
  {
    slug: 'contact-us',
    key: 'contactUs',
    faqs: ['bestWay', 'pressPartnership', 'privacyConcern'],
  },
];

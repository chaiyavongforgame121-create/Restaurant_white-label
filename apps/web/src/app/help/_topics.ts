export interface FAQ {
  q: string;
  a: string;
}

export interface Topic {
  slug: string;
  title: string;
  intro: string;
  faqs: FAQ[];
}

export const TOPICS: Topic[] = [
  {
    slug: 'placing-an-order',
    title: 'Placing an order',
    intro: 'How ordering works, scheduling, modifications.',
    faqs: [
      {
        q: 'How do I place an order?',
        a: 'Browse the menu, tap items to add them to your cart, then tap "Proceed to checkout". You can order as a guest or sign in for faster reorders and loyalty points.',
      },
      {
        q: 'Can I schedule an order for later?',
        a: 'Yes — on the checkout page choose "Schedule for later" and pick a time. The restaurant will start preparing it so it\'s ready right around your chosen time.',
      },
      {
        q: 'Can I customize an item (add toppings, no onions, etc)?',
        a: 'If the item has options, you\'ll see them when you tap it. Pick your modifiers, add notes if needed, then add to cart.',
      },
      {
        q: 'Can I add special instructions for the kitchen?',
        a: 'Yes — every item has a notes field, and the cart has a general note field. The kitchen sees them on the order ticket.',
      },
    ],
  },
  {
    slug: 'cancel-or-refund',
    title: 'Cancel or refund',
    intro: 'Canceling a pending order, refund requests.',
    faqs: [
      {
        q: 'How do I cancel an order?',
        a: 'Go to your order tracking page and tap "Cancel order". You can cancel while the order is still pending or confirmed — once the kitchen starts preparing it, you\'ll need to contact the restaurant.',
      },
      {
        q: 'How long do refunds take?',
        a: 'Card refunds typically appear within 5–10 business days. Cash payments are settled directly with the restaurant.',
      },
      {
        q: 'Can I get a partial refund for one missing item?',
        a: 'Yes — contact the restaurant or email support@favornoms.com with your order number and what was wrong. We\'ll work with the restaurant to refund the affected items.',
      },
    ],
  },
  {
    slug: 'delivery-issues',
    title: 'Delivery issues',
    intro: 'Late deliveries, wrong address, contact driver.',
    faqs: [
      {
        q: 'My order is late — what do I do?',
        a: 'Check the tracking page for the driver\'s live ETA. If they\'ve arrived but you can\'t find them, tap "Call driver".',
      },
      {
        q: 'I entered the wrong address',
        a: 'If the driver hasn\'t picked up the order yet, you can still edit the order from the tracking page. After pickup, call the driver directly.',
      },
      {
        q: 'My food arrived cold or damaged',
        a: 'Email support@favornoms.com with your order number and a photo. We\'ll process a refund.',
      },
    ],
  },
  {
    slug: 'promos-and-loyalty',
    title: 'Promos & loyalty',
    intro: 'Promo codes, points, referrals.',
    faqs: [
      {
        q: 'How do loyalty points work?',
        a: 'You earn 1 point per $1 spent on completed orders. 100 points = $1 off. Redeem on the checkout page (up to 50% of your subtotal).',
      },
      {
        q: 'How do I use a promo code?',
        a: 'On the checkout page, enter the code in the "Promo code" field and tap Apply. Promo codes can\'t be combined unless the restaurant says otherwise.',
      },
      {
        q: 'My promo says expired',
        a: 'Each promo has an expiration date and a maximum number of redemptions. If you think this is an error, email support@favornoms.com.',
      },
    ],
  },
  {
    slug: 'account-and-privacy',
    title: 'Account & privacy',
    intro: 'Sign-in, data, deletion.',
    faqs: [
      {
        q: 'How do I sign in?',
        a: 'Use phone OTP or email magic link from the sign-in page. We don\'t use passwords.',
      },
      {
        q: 'How do I download my data?',
        a: 'Go to /account and tap "Download my data". You\'ll get a JSON file with your orders, addresses, and account info.',
      },
      {
        q: 'How do I delete my account?',
        a: 'Go to /account and tap "Delete account". We\'ll anonymize your personal info but keep order records for tax compliance.',
      },
      {
        q: 'Is my payment info safe?',
        a: 'We never store card details — payments are processed by Stripe, which is PCI-DSS Level 1 certified.',
      },
    ],
  },
  {
    slug: 'contact-us',
    title: 'Contact us',
    intro: 'Email, support hours, escalation.',
    faqs: [
      {
        q: 'What\'s the best way to reach you?',
        a: 'Email support@favornoms.com for order issues, billing questions, or anything else. We respond within a few hours (M-F 9am-9pm ET).',
      },
      {
        q: 'I have a press / partnership inquiry',
        a: 'Email hello@favornoms.com for press, business partnerships, or restaurant onboarding.',
      },
      {
        q: 'I need to report a privacy concern',
        a: 'Email privacy@favornoms.com — see our /privacy and /ccpa pages for your rights.',
      },
    ],
  },
];

import type { DraftMessage } from '$lib/components/playground/message-editor.svelte';
import type { DraftQuestion } from './decision-questions';

export interface ChatExample {
  label: string;
  messages: DraftMessage[];
}

export interface DecisionExample {
  label: string;
  input: string;
  questions: DraftQuestion[];
}

export const CHAT_EXAMPLES: ChatExample[] = [
  {
    label: 'Summarize',
    messages: [
      { role: 'system', content: 'Summarize the text in three short bullet points.' },
      {
        role: 'user',
        content:
          'Our Q3 launch slipped two weeks because the payments provider changed its API. Support tickets rose 18% after launch, mostly about the new checkout flow. Revenue still beat forecast by 6%, driven by annual plans. Next quarter we want to fix checkout, cut ticket volume and expand to two new regions.',
      },
    ],
  },
  {
    label: 'Few-shot classification',
    messages: [
      { role: 'system', content: 'Label each message as bug, feature request or question. Reply with the label only.' },
      { role: 'user', content: 'The export button does nothing when I click it.' },
      { role: 'assistant', content: 'bug' },
      { role: 'user', content: 'Could you add a dark mode?' },
      { role: 'assistant', content: 'feature request' },
      { role: 'user', content: 'How do I invite someone to my workspace?' },
    ],
  },
  {
    label: 'Extract JSON',
    messages: [
      {
        role: 'system',
        content: 'Extract the name, company and email from the text. Reply with a JSON object and nothing else.',
      },
      {
        role: 'user',
        content:
          'Thanks for the call today! Best, Priya Raman, Head of Platform at Apollo Consortium, priya@apollo-consortium.example',
      },
    ],
  },
  {
    label: 'Translate',
    messages: [
      { role: 'system', content: 'Translate the text into French. Reply with the translation only.' },
      { role: 'user', content: 'Your order has shipped and should arrive within three business days.' },
    ],
  },
];

export const DECISION_EXAMPLES: DecisionExample[] = [
  {
    label: 'Spam check',
    input: 'Congratulations! You have been selected for a free cruise. Click the link within 24 hours to claim it.',
    questions: [{ type: 'predicate', name: 'spam', instructions: 'Is this message spam?', options: [] }],
  },
  {
    label: 'Spam check (detailed)',
    input:
      'From: security@paypa1-support.com\nSubject: Your account has been limited\n\nWe noticed unusual sign-in activity on your account. To avoid permanent suspension, verify your identity within 12 hours at http://paypa1-support.com/verify and confirm your card details.',
    questions: [
      { type: 'predicate', name: 'spam', instructions: 'Is this message spam?', options: [] },
      {
        type: 'choice',
        name: 'category',
        instructions: 'What kind of message is this?',
        options: [
          { value: 'legitimate', description: 'A genuine message the recipient would expect' },
          { value: 'marketing', description: 'Unsolicited promotion or advertising' },
          { value: 'phishing', description: 'Tries to steal credentials, payment details or personal data' },
          { value: 'scam', description: 'Fraud such as fake prizes, advance fees or investment schemes' },
          { value: 'malware', description: 'Pushes the recipient to open an attachment or install something' },
        ],
      },
      {
        type: 'predicate',
        name: 'impersonation',
        instructions: 'Does the sender pretend to be a known company, service or person?',
        options: [],
      },
      {
        type: 'predicate',
        name: 'asks_for_credentials',
        instructions: 'Does it ask for a password, card number or other sensitive details?',
        options: [],
      },
      {
        type: 'score',
        name: 'pressure',
        instructions: 'How much urgency or pressure does the message apply?',
        options: [
          { value: 'none', description: 'No deadline or threat' },
          { value: 'some', description: 'A soft deadline or mild nudge' },
          { value: 'heavy', description: 'Threats, countdowns or account suspension' },
        ],
      },
      {
        type: 'score',
        name: 'risk',
        instructions: 'How risky would it be for the recipient to act on this message?',
        options: [
          { value: 'safe', description: 'Nothing to lose by acting on it' },
          { value: 'low', description: 'Minor annoyance at worst' },
          { value: 'high', description: 'Likely to lose money or account access' },
        ],
      },
    ],
  },
  {
    label: 'Support ticket triage',
    input:
      'I was charged twice for my subscription this month and I need the duplicate refunded before my card statement closes on Friday.',
    questions: [
      {
        type: 'choice',
        name: 'team',
        instructions: 'Which team should handle this ticket?',
        options: [
          { value: 'billing', description: 'Charges, refunds and invoices' },
          { value: 'technical', description: 'Bugs, errors and outages' },
          { value: 'sales', description: 'Pricing questions and upgrades' },
        ],
      },
      {
        type: 'score',
        name: 'urgency',
        instructions: 'How urgent is this ticket?',
        options: [
          { value: 'low', description: 'Can wait a few days' },
          { value: 'medium', description: 'Should be handled today' },
          { value: 'high', description: 'Needs attention right now' },
        ],
      },
      { type: 'predicate', name: 'needs_human', instructions: 'Does this need a human to resolve?', options: [] },
    ],
  },
  {
    label: 'Review sentiment',
    input: 'The headphones sound great and the battery lasts all week, but shipping took almost a month.',
    questions: [
      {
        type: 'score',
        name: 'sentiment',
        instructions: 'How positive is this review overall?',
        options: [
          { value: 'negative', description: 'Mostly complaints' },
          { value: 'mixed', description: 'Good and bad in equal measure' },
          { value: 'positive', description: 'Mostly praise' },
        ],
      },
      {
        type: 'predicate',
        name: 'mentions_shipping',
        instructions: 'Does the review mention shipping or delivery?',
        options: [],
      },
    ],
  },
];

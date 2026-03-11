'use client';

export type ChatSwapIntent = {
  type: 'SINGLE_CHAIN_SWAP_INTENT' | 'CROSS_CHAIN_SWAP_INTENT' | 'BRIDGE_INTENT';
  sell: string;
  buy?: string;
  amount: number | string;
  sellTokenChain?: string | null;
  buyTokenChain?: string | null;
};

export type ChatButtonAction =
  | {
      kind: 'RUN_LOCAL';
      actionId: string;
      presetAssistantMessage: string;
    }
  | {
      kind: 'ASK_LLM';
      promptSeed: string;
    };

export type ChatButtonItem = {
  id: string;
  label: string;
  action: ChatButtonAction;
};

export type ChatButtonRowTemplateKey = 'CONFIRM_SWAP' | 'SWAP_FOLLOWUP';

export type ChatButtonRowModel = {
  id: string;
  template: ChatButtonRowTemplateKey;
  buttons: ChatButtonItem[];
  context?: {
    intent?: ChatSwapIntent | null;
    cid?: string | null;
  };
  isActive?: boolean;
  isLocked?: boolean;
  selectedButtonId?: string | null;
};

type ChatButtonRowTemplateFactory = (params: {
  intent: ChatSwapIntent;
  cid?: string | null;
}) => ChatButtonRowModel;

const isSwapIntent = (intent: ChatSwapIntent | null): intent is ChatSwapIntent =>
  Boolean(
    intent &&
      (intent.type === 'SINGLE_CHAIN_SWAP_INTENT' ||
        intent.type === 'CROSS_CHAIN_SWAP_INTENT' ||
        intent.type === 'BRIDGE_INTENT')
  );

const buildConfirmSwapTemplate = (params: {
  intent: ChatSwapIntent;
  cid?: string | null;
}): ChatButtonRowModel => ({
  id: `row-confirm-swap-${Date.now()}`,
  template: 'CONFIRM_SWAP',
  isActive: true,
  isLocked: false,
  selectedButtonId: null,
  context: {
    intent: params.intent,
    cid: params.cid ?? null,
  },
  buttons: [
    {
      id: 'confirm',
      label: 'Confirm',
      action: {
        kind: 'RUN_LOCAL',
        actionId: 'CONFIRM_SWAP',
        presetAssistantMessage: 'Swap confirmed!',
      },
    },
    {
      id: 'cancel',
      label: 'Cancel',
      action: {
        kind: 'RUN_LOCAL',
        actionId: 'CANCEL_SWAP',
        presetAssistantMessage: 'Swap canceled.',
      },
    },
  ],
});

export const CHAT_BUTTON_ROW_TEMPLATES: Record<ChatButtonRowTemplateKey, ChatButtonRowTemplateFactory> = {
  CONFIRM_SWAP: buildConfirmSwapTemplate,
  SWAP_FOLLOWUP: (params) => ({
    id: `row-swap-followup-${Date.now()}`,
    template: 'SWAP_FOLLOWUP',
    isActive: true,
    isLocked: false,
    selectedButtonId: null,
    context: {
      intent: params.intent,
      cid: params.cid ?? null,
    },
    buttons: [
      {
        id: 'start-earning',
        label: `Start Earning with ${String(params.intent.buy ?? params.intent.sell ?? 'TOKEN').toUpperCase()}`,
        action: {
          kind: 'RUN_LOCAL',
          actionId: 'START_EARNING',
          presetAssistantMessage: 'Starting earning flow…',
        },
      },
      {
        id: 'learn-more',
        label: `Learn More About ${String(params.intent.buy ?? params.intent.sell ?? 'TOKEN').toUpperCase()}`,
        action: {
          kind: 'RUN_LOCAL',
          actionId: 'LEARN_MORE',
          presetAssistantMessage: 'Opening token details…',
        },
      },
      {
        id: 'something-else',
        label: 'Something Else',
        action: {
          kind: 'ASK_LLM',
          promptSeed: "The user isn't sure what they want to do next. Suggest practical next steps.",
        },
      },
    ],
  }),
};

export const buildChatButtonRowFromIntent = (params: {
  intent: ChatSwapIntent | null;
  cid?: string | null;
}): ChatButtonRowModel | null => {
  if (!isSwapIntent(params.intent)) return null;
  return CHAT_BUTTON_ROW_TEMPLATES.CONFIRM_SWAP({
    intent: params.intent,
    cid: params.cid ?? null,
  });
};


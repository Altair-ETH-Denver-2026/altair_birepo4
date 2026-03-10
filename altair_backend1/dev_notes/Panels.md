
## Panel Behavior

Panels are persistent UI blocks that appear below the top-right action row and remain visible until explicitly dismissed by a close affordance. Unlike dropdowns, panels do **not** dismiss on outside clicks or unrelated UI interactions.

Panel rendering in the frontend is controlled by [`altair_frontend1/config/ui_config.ts`](../../altair_frontend1/config/ui_config.ts:1). The [`WALLET_DISPLAY`](../../altair_frontend1/config/ui_config.ts:6) setting defines the allowed display options (`panel`, `drop_down`) and selects which mode is active via `active`. When `active` is `panel`, the UI renders the persistent panel variant; when `active` is `drop_down`, the UI renders the transient dropdown variant instead.

### Wallet panels (WALLET_PANEL)

The current implementation applies panel behavior to the wallet display in [`altair_frontend1/src/components/UserMenu.tsx`](../../altair_frontend1/src/components/UserMenu.tsx:14). When the active mode is `panel`, clicking the wallet control shows a **stack** of wallet panels. Each WALLET_PANEL is an independent instance with its own chain selection dropdown state and close “×”.

The wallet panel stack is stored in state as a list of panel objects (`walletPanels`) and rendered in order. Each panel object includes:
- `id` (stable key)
- `chainKey` (which chain’s balances are shown)
- `isChainOpen` (whether that panel’s chain dropdown is open)

Each WALLET_PANEL uses [`WALLET_DISPLAY`](../../altair_frontend1/config/ui_config.ts:6) for sizing, padding, fonts, and dropdown sizing. Token row styling comes from `WALLET_DISPLAY.rows`, `WALLET_DISPLAY.tokenSymbols`, and `WALLET_DISPLAY.tokenBalances`.

Chain labels and dropdown options are config-driven:
- `WALLET_CHAIN_LABELS` controls panel titles (including testnet naming rules).
- `WALLET_CHAIN_OPTIONS` drives dropdown option lists.
### ADD_PANEL (panel adder)

The ADD_PANEL is the compact panel used to add new WALLET_PANEL instances. It is rendered beneath the wallet panel stack and persists across outside clicks. The ADD_PANEL includes:
- A left-aligned “Add Panel:” label (styled by `ADD_PANEL_DISPLAY.label`).
- A wallet icon button with a ring (colors + sizing from `ADD_PANEL_DISPLAY.iconButtons`).
- A chain dropdown that **excludes** chains already represented by open WALLET_PANEL instances.

Selecting a chain from the ADD_PANEL dropdown creates a new WALLET_PANEL instance using that chain. The new panel appears between the existing panels and the ADD_PANEL, pushing the ADD_PANEL downward.

Close behavior:
- Each WALLET_PANEL “×” removes only that panel.
- If the last WALLET_PANEL closes, the wallet icon in the top-right menu returns to its inactive state.

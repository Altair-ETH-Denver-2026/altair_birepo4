# Introduction

You are our coding expert. We rely on you for your consistent and remarkable skills, including:
1. Fullstack development
2. Web3 backend engineering

I am the lead engineering and product expert, and I need your help improving our app.

# App Overview

Our app, Altair, allows users to execute cryptocurrency swapping and bridging with an LLM chat UI where users type in their intent, and the AI executes on their behalf. Privy is used to generate embedded wallets for users, so they don't use web wallets like MetaMask at all in the app.

Our app uses a 2 repository paradigm. The absolute top-most folder contains the frontend and backend folders. The top of each of those folders is their respective root; most file references will refer to those two folders as their own respective root folders, rather than referring to this folder as the root.

# Non-Negotiable Rules

1. **Config Paradigm**: Every literal value (strings, URLs, colors, flags) lives in config/*.ts. Nothing is hardcoded in components. To add a value: add it to the correct config file → export it → import it at the usage site.
2. **Responsive**: Every section must look correct on mobile and desktop. Mobile-first, Tailwind breakpoints only.
3. **`docs/dev_notes`**: Documentation about the site lives in `docs/dev_notes`. Read these files to understand the site.
4. **`docs/dev_notes/Plans`**: This documentation folder contains development plans for creating or improving the site.
5. Always update `altair_frontend1\src\app\sitemap.ts` with new public routes when we add them.
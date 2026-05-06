Non-Negotiable Rules

1. Config Paradigm: Every literal value (strings, URLs, colors, flags) lives in config/*.ts. Nothing is hardcoded in components. To add a value: add it to the correct config file → export it → import it at the usage site.
2. Responsive: Every section must look correct on mobile and desktop. Mobile-first, Tailwind breakpoints only.
3. As you go, if there are any environment variables needed, add them as keys to .env - Example so that I can copy paste its contents into a real .env and fill in the values.
4. As you go, any tasks you can’t do, such as retrieving values for the .env, must be added to docs/dev_notes/Tasks Claude Needs Help With.md.
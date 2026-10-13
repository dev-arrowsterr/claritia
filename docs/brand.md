# Claritia brand

Claritia uses the Omniscient brand system as its base. Read `docs/brand.md` in `dev-omniscient/omniscient` for the full rules. This page lists only what is the same and what changes.

## Same as Omniscient

- The lab-notebook look: white paper, black ink, thin warm-gray lines, square boxes, small mono labels.
- Geist for reading, Geist Mono for labels. Weights 400 and 500.
- The color tokens in Omniscient's `src/app/globals.css` (`ink`, `body`, `muted`, `faint`, `panel`, `canvas`, `line`, `brand`, `fire`, the status colors).
- Square containers, `radius-md` controls, `radius-sm` tags. No pills, card shadows, gradients or emoji.
- `// ` mono captions (`fig`), corner marks on the one box a screen is about, black primary buttons.
- Copy: plain words, short sentences, sentence case, speak to the user as "you".

## What changes for Claritia

- **Logo**: a new mark in the same rounded square, in `brand` with a white stroke. Idea: a check mark inside a viewfinder (the four corner marks), for "see it pass".
- **Test states** use the status tags with these tones:

| State | Tone | Tag |
|---|---|---|
| Passed | green | `PASSED` |
| Failed | red | `FAILED` |
| Healed | violet | `HEALED` |
| Cached | gray | `CACHED` |
| Running | brand | `RUNNING` |
| Flaky | amber | `FLAKY` |
| Needs approval | amber | `NEEDS APPROVAL` |
| Skipped | gray | `SKIPPED` |

- **Failure verdicts**: `APP BUG` red, `FLAKY` amber, `SETUP` gray. Each comes with a one-line reason and a link to the step and video time.
- **Code**: YAML and terminal blocks sit in the dark code window from the Omniscient "Engineering" section (`#161615` ground, keys in `#7fa8f7`, strings in emerald, numbers in amber).
- **The `fire` dot** marks the one failed test that needs you now.

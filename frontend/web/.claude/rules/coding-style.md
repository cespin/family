---
paths:
  - "**/*.jsx"
  - "**/*.js"
  - "**/*.css"
---
# Coding Style — frontend/web

This app is a Vite + React 19 SPA in plain JSX. There is no TypeScript anywhere in `frontend/web`, by choice. Do not introduce `.ts`, `.tsx`, `type` or `interface`.

## Linting

**oxlint**, not ESLint. Config is `.oxlintrc.json` (plugins: `react`, `oxc`). It turns on `react/rules-of-hooks` as an error and `react/only-export-components` as a warning with `allowConstantExport: true`. Run it with `npm run lint`.

There is no `.eslintrc`, so don't cite ESLint configuration or add `eslint-disable` comments. Silence a specific line with a pragma, and explain why next to it:

```jsx
// oxlint-disable-next-line <rule>
```

Don't reach for a pragma to silence a warning you haven't understood.

## File extensions and naming

- `.jsx` for anything containing JSX, `.js` for pure logic.
- Components: `PascalCase` symbol and file (`DashboardScreen.jsx`).
- Screens end in `Screen` and live in `src/screens/`.
- Hooks: `useCamelCase` symbol, with a matching filename (`useSession.js`).
- Tests: `<name>.test.js` or `<name>.test.jsx`, next to the code they test.

## Naming conventions

- Event handlers are `handleClick` or `handleSubmit` inside the component, and the prop that receives one is `onClick` or `onSubmit`.
- Code, comments and docs are in English. User-visible text comes from the catalogs. See `i18n.md`.

## Component shape

```jsx
export function MemberName({ member, onSelect }) {
  return (
    <button type="button" className="fa-member-name" onClick={() => onSelect(member.email)}>
      {member.name}
    </button>
  );
}
```

- Destructure props in the parameter list.
- Prefer a named `export function`. `App` in `src/App.jsx` is the one component with a default export.
- If a prop shape needs documenting, use a comment above the function.
- Use single quotes in JavaScript, and double quotes for JSX attributes.

## JSX

- Self-close tags with no children: `<img />`.
- Fragments (`<>...</>`) over a wrapper `<div>` when no DOM element is needed.
- Conditional rendering: `{condition && <Foo />}` for booleans, a ternary for either/or, an early return for guard clauses.
- Extract multi-line inline logic to a `const` above the `return`.

## CSS

- Plain CSS in a sibling file per component or screen, imported by that component (`Button.jsx` imports `./Button.css`).
- **Every class is prefixed `fa-`**, with BEM-style parts: `fa-button`, `fa-button--primary`, `fa-panel__title`.
- **Tokens only.** No literal colours, spacing, radii, font sizes or durations in a stylesheet. Use the `--fa-*` custom properties in `src/styles/tokens/tokens.css`. If no token fits, add one there, with a dark-mode value when it is a colour. No linter enforces this, so review for it.
- Reuse `src/components/ui/` before writing a new primitive, and export new shared primitives from `src/components/ui/index.js`.
- Global element styles live in `src/styles/global.css`.

## Icons

Icons come from `lucide-react` only. Decorative icons get `aria-hidden="true"`.

## Imports

- **Relative imports only.** No alias is configured, so write `../hooks/useSession.js`, never an absolute or `@/` path.
- Include the file extension. The directory import of `../components/ui` is the one exception.
- Order: React, then third-party packages, then project modules, then the component's own stylesheet last.

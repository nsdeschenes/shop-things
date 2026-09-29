# Frontend Development Guide

> For critical commands and testing rules, see the "Command Execution Guide" section in `/AGENTS.md` in the repository root.

## Frontend Tech Stack

- **Language**: TypeScript
- **Framework**: React 19
- **Build Tool**: Vite
- **Package management**: pnpm
- **State Management**: React Query (TanStack Query)
- **Styling**: StyleXJS
- **Testing**: Vitest, React Testing Library

## Important Files and Directories

- `package.json`: Node.js dependencies and scripts
- `vite.config.ts`: Frontend build configuration
- `tsconfig.json`: TypeScript configuration
- `oxlint.config.ts`: Oxlint configuration
- **Components**: `packages/interface/src/components/{component}/`
- **Utils**: `packages/interface/src/utils/{utility}.tsx`
- **Types**: `packages/interface/src/types/{area}.tsx`

### Routing

- Routes defined in `packages/interface/src/routes`
- Use TanStack Router File Based Routing

### Frontend API Calls

Use `queryOptions` with `useQuery` from TanStack Query. `staleTime` is required.

## General Frontend Rules

1. NO new Reflux stores
2. NO class components
3. NO CSS files (use stylex with the writing-styles skill)
4. ALWAYS use TypeScript
5. ALWAYS colocate tests

## Refs

**NEVER read from or write to a ref (`ref.current`) during render.** This breaks the rules of React — render must be pure, and refs are mutable state that React does not track. Reading a ref during render can return stale values across concurrent renders; writing one is a side effect that makes render impure.

- Read and write `ref.current` **only** inside effects (`useEffect`, `useLayoutEffect`) or event handlers/callbacks — never in the render body.
- If you need a value during render, derive it as a `const` from props/state, or lift it into `useState`/`useMemo`. Reach for a ref only for values that must persist across renders **without** triggering one (DOM nodes, timers, previous-value tracking read later in an effect).

```tsx
// ❌ Reading/writing a ref during render
function Component({ value }: Props) {
  renderCountRef.current += 1; // side effect during render
  const previous = prevValueRef.current; // stale under concurrent rendering
  prevValueRef.current = value; // write during render
  return <div>{previous}</div>;
}

// ✅ Mutate refs in effects; derive render values
function Component({ value }: Props) {
  const prevValueRef = useRef(value);
  useEffect(() => {
    prevValueRef.current = value; // write in an effect
  }, [value]);
  return <div>{value}</div>;
}
```

# ADS-B Aircraft Tracker - Developer Documentation

## Overview

This document provides development guidelines, design patterns, and best practices for the ADS-B Aircraft Tracker desktop application.

For comprehensive architectural documentation, see [DESIGN.md](./DESIGN.md).

---

## Design Patterns and Guidelines

### Global Context Manager Pattern

**When to Use**: State that must persist across page navigation and continue updating in the background.

**Implementation**: React Context Provider mounted in `app/layout.tsx`

#### Pattern Structure

```typescript
// 1. Create Context and Provider
// src/contexts/YourDataContext.tsx
export function YourDataProvider({ children }: { children: ReactNode }) {
  const dataRef = useRef<Map<string, YourData>>(new Map());
  const [updateCounter, setUpdateCounter] = useState(0);

  const handleUpdate = useCallback((update: Update) => {
    // Mutate dataRef in-place (no new object allocation for existing entries)
    const existing = dataRef.current.get(update.id);
    if (existing) {
      Object.assign(existing, update.data);  // In-place mutation
    } else {
      dataRef.current.set(update.id, update.data);
    }
    setUpdateCounter(c => c + 1);  // Trigger re-renders
  }, []);

  useTauriEvent<Update>("your:event", handleUpdate);

  // Memoize context value — only allocates new object when counter changes
  const value = useMemo(
    () => ({ data: dataRef.current, version: updateCounter }),
    [updateCounter]
  );

  return (
    <YourDataContext.Provider value={value}>
      {children}
    </YourDataContext.Provider>
  );
}

// 2. Wrap in layout.tsx
// src/app/layout.tsx
export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <YourDataProvider>
          {children}
        </YourDataProvider>
      </body>
    </html>
  );
}

// 3. Consume in components
// src/hooks/useYourData.ts
export function useYourData(filters: Filters) {
  const { data: dataMap, version } = useYourDataContext();

  const filtered = useMemo(
    () => Array.from(dataMap.values()).filter(applyFilters),
    [version, filters]  // version (not Map ref) triggers recomputation
  );

  return filtered;
}
```

#### Key Principles

1. **Separation of Concerns**:
   - **Provider**: Manages raw data, listens to events, handles lifecycle
   - **Hook**: Applies filters, returns view-specific data

2. **In-Memory Only** (No Persistence by Default):
   - Simpler: No serialization/deserialization
   - Faster: No localStorage overhead
   - Fresher: Data is always current-session
   - Add persistence only when needed (see "When to Add Persistence" below)

3. **Version Counter Pattern**:
   ```typescript
   const [updateCounter, setUpdateCounter] = useState(0);
   // After mutating ref:
   setUpdateCounter(c => c + 1);

   // Expose version in memoized context value
   const value = useMemo(
     () => ({ data: dataRef.current, version: updateCounter }),
     [updateCounter]
   );

   // Consumer hooks use version as useMemo dependency
   const { data, version } = useContext(...);
   const filtered = useMemo(() => filter(data), [version, filters]);
   ```
   - Avoids cloning large Maps/Sets
   - `version` in consumer `useMemo` deps ensures recomputation when data changes
   - Memoized context value prevents unnecessary consumer re-renders
   - **Critical**: Do NOT use the Map ref as a `useMemo` dep — it never changes

4. **Lifecycle Guarantee**:
   - Next.js App Router preserves `layout.tsx` during client-side navigation
   - Provider stays mounted → event listeners keep running
   - Data accumulates continuously, even when no components consume it

#### When to Use Global Context

✅ **Use Global Context When**:
- Data must persist across page navigation (e.g., aircraft tracking history)
- Background updates should continue when UI is inactive (e.g., real-time metrics)
- Multiple pages need the same data source (e.g., dashboard + details view)
- Event-driven updates from outside React (Tauri events, WebSocket)

❌ **Use Component-Local State When**:
- Data is page-specific and doesn't need to survive navigation
- Frequent updates that don't affect all consumers (optimization)
- Simple prop passing (1-2 levels deep) is sufficient
- Form state or transient UI state

#### When to Add Persistence

Add localStorage/IndexedDB only when:
- Users expect data to survive app restarts (e.g., saved filters, preferences)
- Data is expensive to recompute (e.g., large processed datasets)
- Session continuity is critical (e.g., draft edits, shopping cart)

**Don't add persistence for**:
- Real-time streaming data (stale after restart anyway)
- Data that's fast to re-fetch from backend
- Temporary caches (browser memory is sufficient)

#### Performance Considerations

| Aspect | Global Context | Component State |
|--------|----------------|-----------------|
| **Navigation overhead** | None (stays mounted) | Re-mount on each navigation |
| **Event listeners** | 1 global listener | N listeners (one per mount) |
| **Memory footprint** | Persistent (cleared on app close) | Cleared on unmount |
| **Re-render cost** | O(consumers) | O(component tree) |

#### Example Use Cases

**✅ Good Fit for Global Context**:
- Aircraft tracking (current implementation)
- Real-time notification queue
- Global theme/settings
- WebSocket connection state
- Background job status

**❌ Poor Fit for Global Context**:
- Modal open/close state
- Form input values
- Hover/focus UI state
- Pagination current page
- Search query input

#### Testing Global Context

**Verify Persistence Across Navigation**:
1. Mount provider with test data
2. Navigate to different page
3. Return to original page
4. Assert data is still present

**Example Test**:
```typescript
import { render, screen } from '@testing-library/react';
import { YourDataProvider } from '@/contexts/YourDataContext';

test('data persists across navigation', () => {
  const { rerender } = render(
    <YourDataProvider>
      <DashboardPage />
    </YourDataProvider>
  );

  // Add data
  // ...

  // Simulate navigation by remounting child
  rerender(
    <YourDataProvider>
      <SettingsPage />
    </YourDataProvider>
  );

  // Navigate back
  rerender(
    <YourDataProvider>
      <DashboardPage />
    </YourDataProvider>
  );

  // Assert data still exists
  expect(screen.getByText('expected data')).toBeInTheDocument();
});
```

---

## Code Organization

### Directory Structure Conventions

```
src/
├── app/                    # Next.js pages (App Router)
│   ├── layout.tsx         # MUST wrap children in global providers
│   └── page.tsx           # Page components (can mount/unmount)
├── contexts/              # Global React Context providers
│   └── *Context.tsx       # Pattern: {Name}Provider + use{Name}Context hook
├── hooks/                 # Custom React hooks
│   ├── use*.ts           # Component-consumable hooks (filters, derived state)
│   └── useTauriEvent.ts  # Low-level utilities
├── components/            # UI components (presentational)
├── lib/                   # Business logic, utilities, types
└── src-tauri/            # Rust backend (separate concerns)
```

### Naming Conventions

| Type | Pattern | Example |
|------|---------|---------|
| **Context File** | `{Name}Context.tsx` | `AircraftTrackingContext.tsx` |
| **Provider Component** | `{Name}Provider` | `AircraftTrackingProvider` |
| **Context Hook** | `use{Name}Context` | `useAircraftTrackingContext` |
| **Consumer Hook** | `use{Name}` | `useAircraftTracks` (filters + derives) |
| **Component** | `PascalCase.tsx` | `MapInner.tsx` |
| **Utility** | `camelCase.ts` | `colors.ts`, `commands.ts` |

---

## State Management Decision Tree

```mermaid
graph TD
    Start[Need to manage state?] --> Q1{Persists across<br/>navigation?}
    Q1 -->|Yes| Q2{Updates from<br/>outside React?}
    Q1 -->|No| Local[Component useState/useReducer]

    Q2 -->|Yes| Global[Global Context Provider<br/>in layout.tsx]
    Q2 -->|No| Q3{Multiple pages<br/>need it?}

    Q3 -->|Yes| Global
    Q3 -->|No| Local

    Local --> Q4{Persist to<br/>localStorage?}
    Q4 -->|Yes| LocalStorage[useLocalStorage hook]
    Q4 -->|No| LocalState[Plain useState]

    Global --> Q5{Persist to<br/>storage?}
    Q5 -->|Yes| GlobalPersist[Context + localStorage sync]
    Q5 -->|No| GlobalMemory[Context in-memory only]

    style Global fill:#81C784
    style Local fill:#64B5F6
    style GlobalMemory fill:#FFD54F
    style GlobalPersist fill:#FF9800
```

**Decision Guide**:

1. **Does it persist across navigation?**
   - No → Component state
   - Yes → Continue to #2

2. **Updates from outside React?** (Tauri events, WebSocket, timers)
   - Yes → Global Context
   - No → Continue to #3

3. **Multiple pages need it?**
   - Yes → Global Context
   - No → Component state

4. **Persist to localStorage?** (for component state)
   - Yes → `useLocalStorage` hook
   - No → Plain `useState`

5. **Persist to storage?** (for global context)
   - Yes → Context + localStorage sync in provider
   - No → In-memory context (recommended default)

---

## Common Patterns

### Pattern 4: Three-State Collapsible Panel

**Use Case**: A side panel that can be fully hidden, collapsed to a narrow strip, or fully expanded.

```typescript
// State lives in parent (page.tsx); persisted via useLocalStorage
const [panelOpen, setPanelOpen] = useLocalStorage<boolean>("key-open", true);
const [panelWidth, setPanelWidth] = useLocalStorage<number>("key-width", 280);

// Panel is absent from DOM when nothing is selected
{selectedItem && (
  <Panel
    item={selectedItem}
    isOpen={panelOpen}
    width={panelWidth}
    onToggle={() => setPanelOpen(p => !p)}
    onWidthChange={setPanelWidth}
  />
)}
```

**Three states**:
1. **Hidden** (`selectedItem === null`): Panel not rendered; sibling fills available space
2. **Collapsed** (`isOpen === false`): Fixed-width strip (e.g. 32px) with an unfold button
3. **Expanded** (`isOpen === true`): Full content panel with a fold button and draggable resize edge

**Resize edge pattern**: Track `clientX` delta directly inside the component (`useRef` for `lastX` and `isDragging`). Clamp the new width to `[MIN, MAX]` and call `onWidthChange`. This keeps the resize logic encapsulated — the parent only stores/restores the final width value.

**Immutability contract for `first_seen`**: When a track is created, set `first_seen: now` once. The `mergePositionInto` update path must **never** overwrite `first_seen`. This ensures the sparkline x-axis start label always reflects the true first detection time, not the most recent update.

```typescript
// AircraftTrackingContext.tsx — creation only
const track: AircraftTrack = { ..., first_seen: now, last_seen: now };

// mergePositionInto — update path, never touches first_seen
function mergePositionInto(track: AircraftTrack, pos: AircraftPosition, now: number) {
  track.last_seen = now;          // ✅ update last_seen
  // track.first_seen = now;      // ❌ never do this
}
```

---

### Pattern 1: Filtered Data from Global Context

**Use Case**: Derive view-specific data from global state

```typescript
// Hook implementation
export function useFilteredData(filters: Filters) {
  const { data: rawData, version } = useDataContext();

  return useMemo(
    () => Array.from(rawData.values()).filter(item => matchesFilters(item, filters)),
    [version, filters]  // version triggers recomputation, not the stable Map ref
  );
}

// Component usage
function MyComponent() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const data = useFilteredData(filters);

  return <Table data={data} />;
}
```

**Why**: Keeps filtering logic in the hook, components stay clean

### Pattern 2: Derived State with useMemo

**Use Case**: Expensive computations on global state

```typescript
export function useComputedMetrics() {
  const { tracks } = useAircraftTracks();

  const metrics = useMemo(() => ({
    total: tracks.length,
    avgAltitude: tracks.reduce((sum, t) => sum + (t.altitude ?? 0), 0) / tracks.length,
    maxSpeed: Math.max(...tracks.map(t => t.ground_speed ?? 0)),
  }), [tracks]);

  return metrics;
}
```

**Why**: Memoization prevents recomputation on every render

### Pattern 3: Event Listener in Provider

**Use Case**: Background updates from Tauri/WebSocket

```typescript
export function DataProvider({ children }: { children: ReactNode }) {
  const dataRef = useRef<Map<string, Data>>(new Map());
  const [updateCounter, setUpdateCounter] = useState(0);

  const handleEvent = useCallback((payload: Payload) => {
    // Mutate in-place for existing entries
    const existing = dataRef.current.get(payload.id);
    if (existing) {
      Object.assign(existing, payload.data);
    } else {
      dataRef.current.set(payload.id, payload.data);
    }
    setUpdateCounter(c => c + 1);
  }, []);

  useTauriEvent<Payload>("your:event", handleEvent);

  // Memoize context value to avoid new object on every render
  const value = useMemo(
    () => ({ data: dataRef.current, version: updateCounter }),
    [updateCounter]
  );

  return (
    <DataContext.Provider value={value}>
      {children}
    </DataContext.Provider>
  );
}
```

**Why**: Provider stays mounted, listener never unregisters unnecessarily. Memoized value prevents spurious consumer re-renders.

---

## Performance Guidelines

### Do's ✅

1. **Use `useMemo` for expensive filtering**:
   ```typescript
   const filtered = useMemo(
     () => data.filter(applyComplexFilter),
     [data, filterCriteria]
   );
   ```

2. **Use `useCallback` for event handlers passed to children**:
   ```typescript
   const handleClick = useCallback((id: string) => {
     // ...
   }, [dependencies]);
   ```

3. **Batch state updates**:
   ```typescript
   // Good: Single render
   setBatch({ field1: val1, field2: val2 });

   // Bad: Two renders
   setField1(val1);
   setField2(val2);
   ```

4. **Use `React.memo` for expensive child components**:
   ```typescript
   const ExpensiveComponent = React.memo(({ data }) => {
     // ...
   });
   ```

### Don'ts ❌

1. **Don't use Map refs as `useMemo` dependencies**:
   ```typescript
   // Bad: Map ref never changes → useMemo never recomputes → stale data
   const { data: dataMap } = useContext(DataContext);
   const filtered = useMemo(() => filter(dataMap), [dataMap, filters]);

   // Good: Use version counter from context
   const { data: dataMap, version } = useContext(DataContext);
   const filtered = useMemo(() => filter(dataMap), [version, filters]);
   ```

2. **Don't clone large objects unnecessarily**:
   ```typescript
   // Bad: Clones entire map every update
   setData(new Map(dataRef.current));

   // Good: Update counter pattern
   setUpdateCounter(c => c + 1);
   ```

3. **Don't use spread for capped arrays in hot paths**:
   ```typescript
   // Bad: ~800 array allocations/sec with 40 aircraft
   track.positions = [...track.positions.slice(-(MAX - 1)), newPos];

   // Good: In-place mutation
   track.positions.push(newPos);
   if (track.positions.length > MAX) track.positions.shift();
   ```

4. **Don't create inline context values**:
   ```typescript
   // Bad: New object every render → all consumers re-render
   <Context.Provider value={{ data: ref.current }}>

   // Good: Memoized value
   const value = useMemo(() => ({ data: ref.current, version }), [version]);
   <Context.Provider value={value}>
   ```

5. **Don't use context for high-frequency updates**:
   ```typescript
   // Bad: Mouse position in global context (60 FPS re-renders)
   // Good: Mouse position in component state
   ```

6. **Don't run cleanup scans on every data batch**:
   ```typescript
   // Bad: TTL scan on every 500ms batch (most entries aren't expired)
   const handleBatch = () => { process(batch); scanForExpired(); };

   // Good: Separate interval for cleanup
   useEffect(() => {
     const id = setInterval(scanForExpired, 15_000);
     return () => clearInterval(id);
   }, []);
   ```

---

## Migration Guide: Component State → Global Context

**When to Migrate**: When users report data loss after navigation or when background updates are needed.

**Steps**:

1. **Create Context Provider**:
   ```typescript
   // src/contexts/YourDataContext.tsx
   export function YourDataProvider({ children }: { children: ReactNode }) {
     // Move event listener and state logic here
     // ...
   }
   ```

2. **Update Layout**:
   ```typescript
   // src/app/layout.tsx
   <YourDataProvider>
     {children}
   </YourDataProvider>
   ```

3. **Refactor Hook**:
   ```typescript
   // src/hooks/useYourData.ts
   export function useYourData(filters: Filters) {
     const { data, version } = useYourDataContext();
     return useMemo(() => filter(data, filters), [version, filters]);
   }
   ```

4. **Test**:
   - Start app with data
   - Navigate to settings
   - Return to dashboard
   - Verify data persists

---

## Conclusion

The Global Context Manager pattern is the recommended approach for state that must persist across navigation and continue updating in the background. Follow these guidelines to maintain consistent, performant state management across the application.

**Key Takeaways**:
- Use Global Context for cross-page, event-driven state
- Keep providers in `layout.tsx` for persistence
- Expose `version` counter in context value; use it (not Map refs) in consumer `useMemo` deps
- Memoize context value with `useMemo([updateCounter])` to avoid inline object allocation
- Mutate existing objects in-place; use `push()`/`shift()` instead of spread for capped arrays
- Decouple TTL cleanup to a separate interval (not every data batch)
- Default to in-memory, add persistence only when needed
- Apply filters in consumer hooks, not in provider

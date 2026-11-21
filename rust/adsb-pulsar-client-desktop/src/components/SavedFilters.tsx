"use client";
/**
 * Saved callsign/hex filters: pick one, save the current regex under a name
 * (with an optional description), combine saved filters with OR / AND / XOR and
 * NOT, edit or delete your own.
 *
 * A regex filter's selection is derived from the query; a combination is held
 * by `Filters.savedFilterId` (`selectedSavedFilter`).
 */
import { useState } from "react";
import type { Filters } from "@/lib/types";
import { compileCallsignQuery } from "@/lib/callsign-match";
import {
  applySavedFilter,
  describeFilter,
  referencedBy,
  selectedSavedFilter,
  validateSavedFilter,
  type FilterOp,
  type SavedFilter,
  type SavedFilterDraft,
} from "@/lib/saved-filters";

export interface SavedFiltersControlProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
  savedFilters: SavedFilter[];
  onSave: (draft: SavedFilterDraft) => void;
  onDelete: (id: string) => void;
}

const inputClass =
  "w-full px-2 py-1 bg-slate-700 border border-slate-600 rounded text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500";
const smallButton = "px-2 py-0.5 rounded text-[11px] disabled:opacity-40 disabled:cursor-not-allowed";

const OP_LABELS: Record<FilterOp, string> = {
  or: "OR — any",
  and: "AND — all",
  xor: "XOR — exactly one",
};

interface TermRow {
  ref: string;
  not: boolean;
}

interface FormState {
  kind: "regex" | "combine";
  name: string;
  description: string;
  op: FilterOp;
  terms: TermRow[];
  /** The combination being edited: excluded from its own sources. */
  editingId: string | null;
  error: string | null;
}

const EMPTY_ROWS: TermRow[] = [
  { ref: "", not: false },
  { ref: "", not: false },
];

export function SavedFiltersControl({ filters, onChange, savedFilters, onSave, onDelete }: SavedFiltersControlProps) {
  const selected = selectedSavedFilter(savedFilters, filters);
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const pattern = filters.callsign.trim();
  const canSave = filters.callsignRegex && pattern !== "" && !compileCallsignQuery(filters.callsign, true).error;
  const builtins = savedFilters.filter((f) => f.builtin);
  const mine = savedFilters.filter((f) => !f.builtin);
  const own = selected && !selected.builtin ? selected : undefined;
  const isUpdate =
    form !== null && mine.some((f) => f.name.trim().toLowerCase() === form.name.trim().toLowerCase());

  const reset = () => {
    setForm(null);
    setConfirmDelete(null);
    setDeleteError(null);
  };

  const choose = (id: string) => {
    reset();
    onChange(applySavedFilter(filters, savedFilters.find((s) => s.id === id)));
  };

  const blank = { description: "", op: "or" as FilterOp, terms: EMPTY_ROWS, editingId: null, error: null };

  const openRegexForm = () => {
    reset();
    const leaf = own?.pattern !== undefined ? own : undefined;
    setForm({ ...blank, kind: "regex", name: leaf?.name ?? "", description: leaf?.description ?? "" });
  };

  const openCombineForm = (edit?: SavedFilter) => {
    reset();
    if (edit?.combine) {
      setForm({
        kind: "combine",
        name: edit.name,
        description: edit.description ?? "",
        op: edit.combine.op,
        terms: edit.combine.terms.map((t) => ({ ref: t.ref, not: t.not === true })),
        editingId: edit.id,
        error: null,
      });
    } else {
      setForm({ ...blank, kind: "combine", name: "" });
    }
  };

  const setTerm = (i: number, patch: Partial<TermRow>) =>
    form && setForm({ ...form, error: null, terms: form.terms.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  const submit = () => {
    if (!form) return;
    const description = form.description.trim() ? { description: form.description } : {};
    const draft: SavedFilterDraft =
      form.kind === "regex"
        ? { name: form.name, pattern: filters.callsign, ...description }
        : {
            name: form.name,
            ...description,
            combine: {
              op: form.op,
              terms: form.terms
                .filter((t) => t.ref !== "")
                .map((t) => ({ ref: t.ref, ...(t.not && { not: true as const }) })),
            },
          };
    const res = validateSavedFilter(draft, savedFilters);
    if ("error" in res) {
      setForm({ ...form, error: res.error });
      return;
    }
    onSave(form.kind === "regex" ? { ...draft, name: draft.name.trim(), pattern } : { ...draft, name: draft.name.trim() });
    setForm(null);
  };

  const remove = (f: SavedFilter) => {
    if (confirmDelete !== f.id) {
      setConfirmDelete(f.id);
      setDeleteError(null);
      return;
    }
    setConfirmDelete(null);
    const users = referencedBy(savedFilters, f.id);
    if (users.length > 0) {
      setDeleteError(`Used by ${users.map((u) => `'${u.name}'`).join(", ")}: remove it there first`);
      return;
    }
    onDelete(f.id);
    if (f.combine) onChange(applySavedFilter(filters, undefined));
  };

  const sourceOptions = savedFilters.filter((f) => f.id !== form?.editingId);

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <select
          aria-label="Saved filters"
          value={selected?.id ?? ""}
          onChange={(e) => choose(e.target.value)}
          title={selected?.description}
          className="min-w-0 flex-1 px-1.5 py-1 bg-slate-700 border border-slate-600 rounded text-xs text-slate-200"
        >
          <option value="">Saved filters…</option>
          {builtins.length > 0 && (
            <optgroup label="Defaults">
              {builtins.map((f) => (
                <option key={f.id} value={f.id} title={f.description}>
                  {f.name}
                </option>
              ))}
            </optgroup>
          )}
          {mine.length > 0 && (
            <optgroup label="My filters">
              {mine.map((f) => (
                <option key={f.id} value={f.id} title={f.description}>
                  {f.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button
          type="button"
          onClick={openRegexForm}
          disabled={!canSave}
          title={canSave ? "Save this regex as a named filter" : "Switch to regex mode with a valid pattern to save it"}
          className={`${smallButton} text-slate-300 bg-slate-600 hover:bg-slate-500`}
        >
          Save…
        </button>
        {own?.combine ? (
          <button
            type="button"
            onClick={() => openCombineForm(own)}
            title="Edit this combination"
            className={`${smallButton} text-slate-300 bg-slate-600 hover:bg-slate-500`}
          >
            Edit…
          </button>
        ) : (
          <button
            type="button"
            onClick={() => openCombineForm()}
            title="Combine saved filters with OR / AND / XOR and NOT"
            className={`${smallButton} text-slate-300 bg-slate-600 hover:bg-slate-500`}
          >
            Combine…
          </button>
        )}
        {own && (
          <button
            type="button"
            onClick={() => remove(own)}
            onBlur={() => setConfirmDelete(null)}
            className={`${smallButton} ${
              confirmDelete === own.id ? "bg-red-600 text-white" : "text-slate-400 hover:text-red-400"
            }`}
          >
            {confirmDelete === own.id ? "Delete?" : "Delete"}
          </button>
        )}
      </div>

      {deleteError && (
        <p role="alert" className="text-[11px] text-red-400">
          {deleteError}
        </p>
      )}

      {selected?.combine && !form && (
        <p className="font-mono text-[11px] leading-snug text-slate-300">{describeFilter(savedFilters, selected)}</p>
      )}
      {selected?.description && !form && (
        <p className="text-[11px] leading-snug text-slate-500">{selected.description}</p>
      )}

      {form && (
        <form
          className="flex flex-col gap-1 rounded border border-slate-700 p-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor="saved-filter-name" className="text-[11px] text-slate-400">
            Name
          </label>
          <input
            id="saved-filter-name"
            autoFocus
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value, error: null })}
            className={inputClass}
          />
          <label htmlFor="saved-filter-description" className="text-[11px] text-slate-400">
            Description (optional)
          </label>
          <textarea
            id="saved-filter-description"
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className={inputClass}
          />
          {form.kind === "combine" && (
            <>
              <label htmlFor="saved-filter-op" className="text-[11px] text-slate-400">
                Operator
              </label>
              <select
                id="saved-filter-op"
                value={form.op}
                onChange={(e) => setForm({ ...form, op: e.target.value as FilterOp, error: null })}
                className={inputClass}
              >
                {(Object.keys(OP_LABELS) as FilterOp[]).map((op) => (
                  <option key={op} value={op}>
                    {OP_LABELS[op]}
                  </option>
                ))}
              </select>
              <ul className="flex flex-col gap-1">
                {form.terms.map((t, i) => (
                  <li key={i} className="flex items-center gap-1">
                    <label className="flex items-center gap-0.5 text-[10px] text-slate-400" title="Negate this filter">
                      <input
                        type="checkbox"
                        aria-label={`NOT ${i + 1}`}
                        checked={t.not}
                        onChange={(e) => setTerm(i, { not: e.target.checked })}
                        className="accent-blue-500"
                      />
                      NOT
                    </label>
                    <select
                      aria-label={`Filter ${i + 1}`}
                      value={t.ref}
                      onChange={(e) => setTerm(i, { ref: e.target.value })}
                      className={`${inputClass} min-w-0 flex-1`}
                    >
                      <option value="">Choose a filter…</option>
                      {sourceOptions.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label={`Remove filter ${i + 1}`}
                      onClick={() => setForm({ ...form, error: null, terms: form.terms.filter((_, j) => j !== i) })}
                      className={`${smallButton} text-slate-500 hover:text-red-400`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => setForm({ ...form, terms: [...form.terms, { ref: "", not: false }] })}
                className={`${smallButton} self-start text-slate-400 hover:text-slate-200`}
              >
                + Add filter
              </button>
            </>
          )}
          {form.error && (
            <p role="alert" className="text-[11px] text-red-400">
              {form.error}
            </p>
          )}
          <div className="flex justify-end gap-1">
            <button type="button" onClick={() => setForm(null)} className={`${smallButton} text-slate-400 hover:text-slate-200`}>
              Cancel
            </button>
            <button type="submit" className={`${smallButton} bg-blue-600 text-white hover:bg-blue-500`}>
              {isUpdate ? "Update" : "Save"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

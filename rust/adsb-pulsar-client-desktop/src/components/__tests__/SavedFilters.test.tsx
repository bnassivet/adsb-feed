import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SavedFiltersControl } from "../SavedFilters";
import { DEFAULT_FILTERS, type Filters } from "@/lib/types";
import { BUILTIN_FILTERS, allSavedFilters, type SavedFilter } from "@/lib/saved-filters";

const mine: SavedFilter = { id: "u1", name: "French majors", pattern: "^(AFR|TVF)\\d+$", description: "AF + Transavia" };
const hex = BUILTIN_FILTERS[0];

function setup(filters: Filters = DEFAULT_FILTERS) {
  const onChange = vi.fn();
  const onSave = vi.fn();
  const onDelete = vi.fn();
  render(
    <SavedFiltersControl
      filters={filters}
      onChange={onChange}
      savedFilters={allSavedFilters([mine])}
      onSave={onSave}
      onDelete={onDelete}
    />,
  );
  return { onChange, onSave, onDelete, user: userEvent.setup() };
}

const regex = (callsign: string): Filters => ({ ...DEFAULT_FILTERS, callsign, callsignRegex: true });

describe("SavedFiltersControl", () => {
  it("lists defaults and the user's filters", () => {
    setup();
    const select = screen.getByRole("combobox", { name: /saved filters/i });
    expect(select).toHaveValue("");
    expect(screen.getByRole("option", { name: hex.name })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: mine.name })).toBeInTheDocument();
  });

  it("selecting a filter applies its pattern in regex mode, keeping other filters", async () => {
    const start = { ...DEFAULT_FILTERS, altitudeMin: 5000 };
    const { onChange, user } = setup(start);
    await user.selectOptions(screen.getByRole("combobox", { name: /saved filters/i }), hex.id);
    expect(onChange).toHaveBeenCalledWith({ ...start, callsign: hex.pattern!, callsignRegex: true, savedFilterId: null });
  });

  it("choosing the placeholder clears the query", async () => {
    const { onChange, user } = setup(regex(mine.pattern!));
    await user.selectOptions(screen.getByRole("combobox", { name: /saved filters/i }), "");
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_FILTERS, callsign: "", callsignRegex: true, savedFilterId: null });
  });

  it("shows the selected filter and its description", () => {
    setup(regex(hex.pattern!));
    expect(screen.getByRole("combobox", { name: /saved filters/i })).toHaveValue(hex.id);
    expect(screen.getByText(hex.description!)).toBeInTheDocument();
  });

  it("disables Save in substring mode, with an invalid regex, or an empty one", () => {
    for (const f of [{ ...DEFAULT_FILTERS, callsign: "AFR" }, regex("AFR("), regex("  ")]) {
      const r = render(
        <SavedFiltersControl filters={f} onChange={vi.fn()} savedFilters={[]} onSave={vi.fn()} onDelete={vi.fn()} />,
      );
      expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
      r.unmount();
    }
  });

  it("saves a new filter with name and description", async () => {
    const { onSave, user } = setup(regex("^RCH"));
    await user.click(screen.getByRole("button", { name: /save/i }));
    await user.type(screen.getByLabelText(/^name/i), "Reach");
    await user.type(screen.getByLabelText(/description/i), "USAF airlift");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ name: "Reach", pattern: "^RCH", description: "USAF airlift" });
    expect(screen.queryByLabelText(/^name/i)).not.toBeInTheDocument();
  });

  it("shows a validation error instead of saving without a name", async () => {
    const { onSave, user } = setup(regex("^RCH"));
    await user.click(screen.getByRole("button", { name: /save/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/name is required/i);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("offers Update, prefilled, when the name is an existing user filter", async () => {
    const { onSave, user } = setup(regex(mine.pattern!));
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(screen.getByLabelText(/^name/i)).toHaveValue(mine.name);
    expect(screen.getByLabelText(/description/i)).toHaveValue(mine.description);
    await user.click(screen.getByRole("button", { name: /^update$/i }));
    expect(onSave).toHaveBeenCalledWith({ name: mine.name, pattern: mine.pattern, description: mine.description });
  });

  it("does not prefill a built-in's name (reserved)", async () => {
    const { user } = setup(regex(hex.pattern!));
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(screen.getByLabelText(/^name/i)).toHaveValue("");
  });

  it("deletes a user filter after a confirming second click", async () => {
    const { onDelete, user } = setup(regex(mine.pattern!));
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /delete\?/i }));
    expect(onDelete).toHaveBeenCalledWith(mine.id);
  });

  it("has no Delete for a built-in", () => {
    setup(regex(hex.pattern!));
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });

  describe("combined filters", () => {
    const combo: SavedFilter = {
      id: "c1",
      name: "FR not AF",
      combine: { op: "and", terms: [{ ref: hex.id }, { ref: mine.id, not: true }] },
      description: "French military, no Air France",
    };

    function setupCombo(filters: Filters = DEFAULT_FILTERS, user: SavedFilter[] = [mine, combo]) {
      const onChange = vi.fn();
      const onSave = vi.fn();
      const onDelete = vi.fn();
      render(
        <SavedFiltersControl
          filters={filters}
          onChange={onChange}
          savedFilters={allSavedFilters(user)}
          onSave={onSave}
          onDelete={onDelete}
        />,
      );
      return { onChange, onSave, onDelete, user: userEvent.setup() };
    }

    it("selecting a combination holds it by id and empties the query", async () => {
      const { onChange, user } = setupCombo({ ...DEFAULT_FILTERS, callsign: "AFR" });
      await user.selectOptions(screen.getByRole("combobox", { name: /saved filters/i }), "c1");
      expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_FILTERS, callsign: "", savedFilterId: "c1" });
    });

    it("shows the expression of the selected combination", () => {
      setupCombo({ ...DEFAULT_FILTERS, savedFilterId: "c1" });
      expect(screen.getByRole("combobox", { name: /saved filters/i })).toHaveValue("c1");
      expect(screen.getByText(`${hex.name} AND NOT ${mine.name}`)).toBeInTheDocument();
    });

    it("creates a combination: operator, sources, NOT", async () => {
      const { onSave, user } = setupCombo();
      await user.click(screen.getByRole("button", { name: /combine/i }));
      await user.type(screen.getByLabelText(/^name/i), "Mil or majors");
      await user.selectOptions(screen.getByLabelText(/operator/i), "xor");
      await user.selectOptions(screen.getByLabelText(/^filter 1$/i), hex.id);
      await user.selectOptions(screen.getByLabelText(/^filter 2$/i), mine.id);
      await user.click(screen.getByLabelText(/^not 2$/i));
      await user.click(screen.getByRole("button", { name: /^save$/i }));
      expect(onSave).toHaveBeenCalledWith({
        name: "Mil or majors",
        combine: { op: "xor", terms: [{ ref: hex.id }, { ref: mine.id, not: true }] },
      });
    });

    it("adds and removes terms; empty rows are ignored", async () => {
      const { onSave, user } = setupCombo();
      await user.click(screen.getByRole("button", { name: /combine/i }));
      await user.type(screen.getByLabelText(/^name/i), "Just one");
      await user.click(screen.getByRole("button", { name: /add filter/i }));
      expect(screen.getByLabelText(/^filter 3$/i)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /remove filter 3/i }));
      expect(screen.queryByLabelText(/^filter 3$/i)).not.toBeInTheDocument();
      await user.selectOptions(screen.getByLabelText(/^filter 1$/i), hex.id);
      await user.click(screen.getByLabelText(/^not 1$/i));
      await user.click(screen.getByRole("button", { name: /^save$/i }));
      expect(onSave).toHaveBeenCalledWith({ name: "Just one", combine: { op: "or", terms: [{ ref: hex.id, not: true }] } });
    });

    it("refuses an empty combination", async () => {
      const { onSave, user } = setupCombo();
      await user.click(screen.getByRole("button", { name: /combine/i }));
      await user.type(screen.getByLabelText(/^name/i), "Nothing");
      await user.click(screen.getByRole("button", { name: /^save$/i }));
      expect(screen.getByRole("alert")).toHaveTextContent(/at least one/i);
      expect(onSave).not.toHaveBeenCalled();
    });

    it("edits the selected user combination, prefilled, without offering itself as a source", async () => {
      const { onSave, user } = setupCombo({ ...DEFAULT_FILTERS, savedFilterId: "c1" });
      await user.click(screen.getByRole("button", { name: /edit/i }));
      expect(screen.getByLabelText(/^name/i)).toHaveValue("FR not AF");
      expect(screen.getByLabelText(/operator/i)).toHaveValue("and");
      expect(screen.getByLabelText(/^filter 1$/i)).toHaveValue(hex.id);
      expect(screen.getByLabelText(/^not 2$/i)).toBeChecked();
      const options = Array.from((screen.getByLabelText(/^filter 1$/i) as HTMLSelectElement).options).map((o) => o.value);
      expect(options).not.toContain("c1");
      await user.selectOptions(screen.getByLabelText(/operator/i), "or");
      await user.click(screen.getByRole("button", { name: /^update$/i }));
      expect(onSave).toHaveBeenCalledWith({
        name: "FR not AF",
        description: "French military, no Air France",
        combine: { op: "or", terms: [{ ref: hex.id }, { ref: mine.id, not: true }] },
      });
    });

    it("refuses to delete a filter used by a combination", async () => {
      const { onDelete, user } = setupCombo(regex(mine.pattern!));
      await user.click(screen.getByRole("button", { name: /^delete$/i }));
      await user.click(screen.getByRole("button", { name: /delete\?/i }));
      expect(onDelete).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(/used by.*FR not AF/i);
    });

    it("deleting the selected combination also clears the selection", async () => {
      const { onDelete, onChange, user } = setupCombo({ ...DEFAULT_FILTERS, savedFilterId: "c1" });
      await user.click(screen.getByRole("button", { name: /^delete$/i }));
      await user.click(screen.getByRole("button", { name: /delete\?/i }));
      expect(onDelete).toHaveBeenCalledWith("c1");
      expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_FILTERS, callsign: "", savedFilterId: null });
    });

    it("the military default combination is listed", () => {
      setupCombo();
      expect(screen.getByRole("option", { name: "Military — hex or callsign (NATO/EU)" })).toBeInTheDocument();
    });
  });
});

# Notebook Optimization Summary

## Problem
The `analysis_sbs_records.ipynb` notebook was **196 MB** with **5.2 million lines** due to embedded Plotly visualization outputs containing large ADS-B datasets.

## Solution Implemented

### 1. Cleared Notebook Outputs ✓
- Removed all cell outputs from the notebook
- **Result:** Reduced from 196 MB to 48 KB

### 2. Git Filters for Automatic Cleaning ✓
Created `.gitattributes` and configured git filters to automatically strip outputs before committing:

```bash
# In .gitattributes
*.ipynb filter=jupyter_clear_output diff=ipynb

# Git filter configuration (already set)
git config filter.jupyter_clear_output.clean "python3 -c '...'"
git config filter.jupyter_clear_output.smudge cat
```

**Benefit:** Notebooks will automatically be cleaned when committed to git, preventing large files from being checked in.

### 3. Data Export/Import Functions ✓
Added helper functions to cache processed dataframes:

```python
# Save large processed dataframes to avoid re-embedding in visualizations
save_pdf(large_dataframe, "positions_data")

# Reload cached data
pdf = load_pdf("positions_data")
```

**Benefit:**
- Processed dataframes can be cached to `./data_cache/` as Parquet files
- Avoids reprocessing large datasets
- Can load pre-processed data for visualizations without embedding in notebook

### 4. Replaced Inline Visualizations ✓
Replaced `.show()` calls with HTML exports:

**Before:**
```python
fig_density.show()  # Embeds 70+ MB of data in notebook output
```

**After:**
```python
# Visualization exported to HTML file in next cell
# To view: open ./figures/density_plot.html in browser
print(f"Density plot will be exported to: {fig_export_path}/density_plot.html")
plotly.offline.plot(fig_density, filename=f"{fig_export_path}/density_plot.html")
```

**Modified cells:** 84, 88, 118, 123

## Results

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| File size | 196 MB | 50 KB | **99.97% reduction** |
| Line count | 5,260,951 | 1,817 | **99.97% reduction** |
| Git-friendly | No | Yes | Auto-clean on commit |

## Usage Guidelines

### Viewing Visualizations
All Plotly visualizations are exported to `./figures/` directory:
- Open HTML files in your browser to view interactive visualizations
- Files are persistent and can be shared independently of the notebook

### Working with Large Datasets
```python
# 1. Process data
pdf = df_positions.toPandas()

# 2. Save to cache (optional but recommended)
save_pdf(pdf, "positions_june_2023")

# 3. Later, reload from cache instead of reprocessing
pdf = load_pdf("positions_june_2023")
if pdf is None:
    # Cache miss - reprocess
    pdf = df_positions.toPandas()
    save_pdf(pdf, "positions_june_2023")

# 4. Create visualization and export to HTML
fig = px.scatter_mapbox(pdf, ...)
plotly.offline.plot(fig, filename=f"{fig_export_path}/my_plot.html")
```

### Git Best Practices
- The `.gitattributes` filter ensures outputs are never committed
- You can run cells and see outputs during development
- When you commit, outputs are automatically stripped
- No need to manually clear outputs before committing

## Files Modified
- `adsb-feed/src/notebooks/analysis_sbs_records.ipynb` - Optimized notebook
- `adsb-feed/.gitattributes` - Git filter configuration (created)
- Git config - Added jupyter_clear_output filter (local repo setting)

## Maintenance
- The `./figures/` directory will grow as you export visualizations
- The `./data_cache/` directory will store processed dataframes
- Both directories should be added to `.gitignore` if not already

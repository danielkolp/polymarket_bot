"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { MarketFilters } from "@/lib/hooks/useMarkets";

// value = Polymarket tag slug, label = display name.
const CATEGORIES: { value: string; label: string }[] = [
  { value: "all", label: "All categories" },
  { value: "politics", label: "Politics" },
  { value: "crypto", label: "Crypto" },
  { value: "sports", label: "Sports" },
  { value: "pop-culture", label: "Pop Culture" },
  { value: "business", label: "Business" },
  { value: "economy", label: "Economy" },
  { value: "science", label: "Science" },
  { value: "tech", label: "Tech" },
  { value: "world", label: "World" },
];

function numOrUndef(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function ScannerFilters({
  filters,
  onChange,
}: {
  filters: MarketFilters;
  onChange: (next: MarketFilters) => void;
}) {
  const set = (patch: Partial<MarketFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
      <div className="col-span-2 sm:col-span-1">
        <Label>Search</Label>
        <Input
          className="mt-1"
          placeholder="Question contains…"
          value={filters.search ?? ""}
          onChange={(e) => set({ search: e.target.value || undefined })}
        />
      </div>

      <div>
        <Label>Category</Label>
        <Select
          className="mt-1"
          value={filters.category ?? "all"}
          onChange={(e) => set({ category: e.target.value })}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>

      <div>
        <Label>Status</Label>
        <Select
          className="mt-1"
          value={filters.status}
          onChange={(e) => set({ status: e.target.value as MarketFilters["status"] })}
        >
          <option value="active">Active</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </Select>
      </div>

      <div>
        <Label>Min liquidity ($)</Label>
        <Input
          className="mt-1"
          type="number"
          placeholder="0"
          value={filters.minLiquidity ?? ""}
          onChange={(e) => set({ minLiquidity: numOrUndef(e.target.value) })}
        />
      </div>

      <div>
        <Label>Min volume ($)</Label>
        <Input
          className="mt-1"
          type="number"
          placeholder="0"
          value={filters.minVolume ?? ""}
          onChange={(e) => set({ minVolume: numOrUndef(e.target.value) })}
        />
      </div>

      <div>
        <Label>Min spread (¢)</Label>
        <Input
          className="mt-1"
          type="number"
          step="0.5"
          placeholder="0"
          value={filters.minSpread != null ? filters.minSpread * 100 : ""}
          onChange={(e) => {
            const n = numOrUndef(e.target.value);
            set({ minSpread: n != null ? n / 100 : undefined });
          }}
        />
      </div>

      <div>
        <Label>Max days to res.</Label>
        <Input
          className="mt-1"
          type="number"
          placeholder="∞"
          value={filters.maxDaysToResolution ?? ""}
          onChange={(e) => set({ maxDaysToResolution: numOrUndef(e.target.value) })}
        />
      </div>
    </div>
  );
}

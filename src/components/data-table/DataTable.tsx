"use client";

import { DataPoint, ChartConfig } from "@/lib/types";
import { Download, Trash2, FileSpreadsheet } from "lucide-react";
import Papa from "papaparse";

interface DataTableProps {
  dataPoints: DataPoint[];
  config: ChartConfig;
  onRemove: (id: string) => void;
  onUpdateValue: (id: string, value: number) => void;
}

export function DataTable({
  dataPoints,
  config,
  onRemove,
  onUpdateValue,
}: DataTableProps) {
  const sorted = [...dataPoints].sort((a, b) => {
    if (a.day !== b.day) return a.day - b.day;
    return a.hour - b.hour;
  });

  const handleExportCSV = () => {
    const rows = sorted.map((p) => ({
      Dan: p.dayLabel,
      Vrijeme: p.timeLabel,
      [`Vrijednost (${config.unit})`]: p.value,
    }));
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${config.type}_podaci.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Podaci</h3>
          <p className="text-[11px] text-muted-foreground">
            {dataPoints.length} točaka
          </p>
        </div>
        <button
          onClick={handleExportCSV}
          disabled={dataPoints.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed shadow-sm"
        >
          <Download className="w-3.5 h-3.5" />
          CSV
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-hidden bg-card border border-border/60 rounded-2xl flex flex-col">
        {/* Table header */}
        <div className="grid grid-cols-[1fr_70px_80px_28px] gap-1 px-3 py-2 border-b border-border/40 bg-muted/30">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Dan
          </span>
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Vrijeme
          </span>
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider text-right">
            {config.unit}
          </span>
          <span />
        </div>

        {/* Rows */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-12 text-center">
              <FileSpreadsheet className="w-10 h-10 text-muted-foreground/20 mb-3" />
              <p className="text-sm text-muted-foreground/60">
                Kliknite na graf za
              </p>
              <p className="text-sm text-muted-foreground/60">
                prikupljanje podataka
              </p>
            </div>
          ) : (
            sorted.map((point, i) => (
              <div
                key={point.id}
                className="grid grid-cols-[1fr_70px_80px_28px] gap-1 items-center px-3 py-1.5 border-b border-border/20 hover:bg-muted/20 transition-colors group animate-fade-in"
                style={{ animationDelay: `${Math.min(i * 20, 200)}ms` }}
              >
                <span className="text-xs font-medium text-foreground truncate">
                  {point.dayLabel}
                </span>
                <span className="text-xs font-mono text-muted-foreground">
                  {point.timeLabel}
                </span>
                <input
                  type="number"
                  step={0.1}
                  value={point.value}
                  onChange={(e) =>
                    onUpdateValue(point.id, parseFloat(e.target.value) || 0)
                  }
                  className="w-full px-1.5 py-0.5 text-xs font-mono text-right bg-transparent border border-transparent rounded-md transition-colors focus:border-primary/40 focus:outline-none focus:bg-muted/30 hover:border-border"
                />
                <button
                  onClick={() => onRemove(point.id)}
                  className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 transition-all opacity-0 group-hover:opacity-100"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Footer stats */}
        {sorted.length > 0 && (
          <div className="px-3 py-2 border-t border-border/40 bg-muted/20">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono">
              <span>
                Min:{" "}
                <span className="text-foreground font-medium">
                  {Math.min(...sorted.map((p) => p.value)).toFixed(1)}
                </span>
              </span>
              <span>
                Max:{" "}
                <span className="text-foreground font-medium">
                  {Math.max(...sorted.map((p) => p.value)).toFixed(1)}
                </span>
              </span>
              <span>
                Avg:{" "}
                <span className="text-foreground font-medium">
                  {(
                    sorted.reduce((s, p) => s + p.value, 0) / sorted.length
                  ).toFixed(1)}
                </span>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

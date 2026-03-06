"use client";

import { DataPoint, ChartConfig } from "@/lib/types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Download, Trash2 } from "lucide-react";
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
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">
          Prikupljene točke ({dataPoints.length})
        </h3>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExportCSV}
          disabled={dataPoints.length === 0}
        >
          <Download className="w-4 h-4 mr-1" />
          CSV
        </Button>
      </div>

      <div className="max-h-80 overflow-y-auto border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">Dan</TableHead>
              <TableHead className="w-20">Vrijeme</TableHead>
              <TableHead className="w-24">
                {config.unit}
              </TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-gray-400 py-8">
                  Kliknite na graf za prikupljanje podataka
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((point) => (
                <TableRow key={point.id}>
                  <TableCell className="font-medium text-sm">
                    {point.dayLabel}
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {point.timeLabel}
                  </TableCell>
                  <TableCell>
                    <input
                      type="number"
                      step={0.1}
                      value={point.value}
                      onChange={(e) =>
                        onUpdateValue(point.id, parseFloat(e.target.value) || 0)
                      }
                      className="w-20 px-1.5 py-0.5 text-sm border rounded text-right
                                 focus:outline-none focus:ring-1 focus:ring-green-500"
                    />
                  </TableCell>
                  <TableCell>
                    <button
                      onClick={() => onRemove(point.id)}
                      className="text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

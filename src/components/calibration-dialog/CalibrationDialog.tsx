"use client";

import { useState, useEffect } from "react";
import { ChartConfig } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getDayName } from "@/lib/chart-geometry";

interface CalibrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: ChartConfig;
  onConfirm: (data: { day: number; hour: number; value: number }) => void;
  initial?: { day?: number; hour?: number; value?: number };
}

const DAY_OPTIONS = [
  { v: 0, label: "Pon (0)" },
  { v: 1, label: "Uto (1)" },
  { v: 2, label: "Sri (2)" },
  { v: 3, label: "Čet (3)" },
  { v: 4, label: "Pet (4)" },
  { v: 5, label: "Sub (5)" },
  { v: 6, label: "Ned (6)" },
  { v: 7, label: "Pon idući (7)" },
];

export function CalibrationDialog({
  open,
  onOpenChange,
  config,
  onConfirm,
  initial,
}: CalibrationDialogProps) {
  const defaultValue = (config.minValue + config.maxValue) / 2;
  const [day, setDay] = useState(initial?.day ?? 0);
  const [hour, setHour] = useState(initial?.hour ?? 0);
  const [value, setValue] = useState(initial?.value ?? defaultValue);

  useEffect(() => {
    if (open) {
      setDay(initial?.day ?? 0);
      setHour(initial?.hour ?? 0);
      setValue(initial?.value ?? defaultValue);
    }
  }, [open, initial, defaultValue]);

  const submit = () => {
    onConfirm({ day, hour, value });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Identifikacija kalibracijske točke</DialogTitle>
          <DialogDescription>
            Koja je točka grafa kliknuta? Unesite dan, sat i vrijednost.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Dan
            </label>
            <select
              value={day}
              onChange={(e) => setDay(parseInt(e.target.value))}
              className="w-full bg-muted/40 border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {DAY_OPTIONS.map((d) => (
                <option key={d.v} value={d.v}>
                  {d.label} — {getDayName(d.v)}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Sat (0–24)
              </label>
              <input
                type="number"
                min={0}
                max={24}
                step={0.25}
                value={hour}
                onChange={(e) => setHour(parseFloat(e.target.value) || 0)}
                className="w-full bg-muted/40 border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {config.label} ({config.unit})
              </label>
              <input
                type="number"
                min={config.minValue}
                max={config.maxValue}
                step={config.fineGrid}
                value={value}
                onChange={(e) =>
                  setValue(parseFloat(e.target.value) || config.minValue)
                }
                className="w-full bg-muted/40 border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          </div>

          <div className="text-[11px] text-muted-foreground bg-muted/30 rounded-md px-3 py-2">
            Raspon vrijednosti: {config.minValue}–{config.maxValue} {config.unit}.
            Tip: kliknite na jasnu sjecišnu točku rešetke (npr. ponoć × cijeli broj).
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Odustani
          </Button>
          <Button onClick={submit}>Potvrdi</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

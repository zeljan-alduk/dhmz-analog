"use client";

import { useCallback, useRef, useState } from "react";
import { Upload, Camera, Image as ImageIcon } from "lucide-react";

interface ImageUploadProps {
  onImageSelected: (file: File) => void;
}

export function ImageUpload({ onImageSelected }: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleFile = useCallback(
    (file: File) => {
      if (file.type.startsWith("image/") || file.type === "application/pdf") {
        onImageSelected(file);
      }
    },
    [onImageSelected]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  return (
    <div
      onDrop={handleDrop}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onClick={() => inputRef.current?.click()}
      className={`group relative cursor-pointer overflow-hidden rounded-2xl border-2 border-dashed transition-all duration-300 ${
        isDragOver
          ? "border-primary bg-primary/5 scale-[1.01]"
          : "border-border/60 hover:border-primary/40 hover:bg-muted/30"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />

      <div className="flex flex-col items-center gap-5 py-16 px-8">
        {/* Icon cluster */}
        <div className="relative">
          <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary transition-all duration-300">
            <Upload className="w-7 h-7" />
          </div>
          <div className="absolute -right-3 -bottom-2 w-8 h-8 rounded-xl bg-card border border-border/60 flex items-center justify-center text-muted-foreground shadow-sm">
            <Camera className="w-4 h-4" />
          </div>
        </div>

        <div className="text-center">
          <p className="text-base font-semibold text-foreground mb-1">
            Povucite sliku ovdje
          </p>
          <p className="text-sm text-muted-foreground">
            ili kliknite za odabir datoteke
          </p>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-muted/50 text-xs text-muted-foreground">
          <ImageIcon className="w-3.5 h-3.5" />
          JPG, PNG — fotografija ili sken
        </div>
      </div>
    </div>
  );
}

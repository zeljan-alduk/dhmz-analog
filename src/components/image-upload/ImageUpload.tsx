"use client";

import { useCallback, useRef } from "react";
import { Upload, Camera } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ImageUploadProps {
  onImageSelected: (file: File) => void;
}

export function ImageUpload({ onImageSelected }: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);

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
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  return (
    <div
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      className="border-2 border-dashed border-gray-300 rounded-xl p-12 text-center
                 hover:border-green-500 hover:bg-green-50/50 transition-colors cursor-pointer"
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleChange}
      />
      <div className="flex flex-col items-center gap-4">
        <div className="flex gap-4">
          <Upload className="w-12 h-12 text-gray-400" />
          <Camera className="w-12 h-12 text-gray-400" />
        </div>
        <div>
          <p className="text-lg font-medium text-gray-700">
            Povucite sliku ovdje ili kliknite za odabir
          </p>
          <p className="text-sm text-gray-500 mt-1">
            Fotografija ili sken trake (JPG, PNG)
          </p>
        </div>
        <Button variant="outline" className="mt-2">
          Odaberi datoteku
        </Button>
      </div>
    </div>
  );
}

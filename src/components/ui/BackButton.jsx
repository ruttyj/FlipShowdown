import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

// Shared back button: arrow and "Back" side by side, left-aligned (not centred).
export default function BackButton({ onClick, disabled = false, className }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                'inline-flex items-center justify-start gap-1.5 rounded px-2 py-1 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent-vivid disabled:pointer-events-none disabled:opacity-50',
                className
            )}
        >
            <ArrowLeft className="w-5 h-5" aria-hidden="true" />
            <span>Back</span>
        </button>
    );
}

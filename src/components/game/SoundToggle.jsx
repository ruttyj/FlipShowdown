import React from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function SoundToggle({ isMuted, onToggle }) {
    const label = isMuted ? 'Unmute sounds' : 'Mute sounds';

    return (
        <Button
            onClick={onToggle}
            variant="outline"
            size="icon"
            className="sound-toggle h-10 w-10 rounded-full"
            aria-label={label}
            title={label}
        >
            {isMuted ? (
                <VolumeX className="w-5 h-5 text-slate-500" />
            ) : (
                <Volume2 className="w-5 h-5 text-slate-600" />
            )}
        </Button>
    );
}
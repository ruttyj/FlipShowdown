import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { backend } from '@/api/backend';
import { Loader2, LogIn, LogOut } from 'lucide-react';

function displayNameFor(user) {
    if (user.full_name) {
        return user.full_name;
    }
    return user.email.split('@')[0];
}

/** Shows who is signed in with a log out button, or a sign in button when nobody is. */
export default function AccountBar({ user }) {
    const [isLoggingOut, setIsLoggingOut] = useState(false);

    const logOut = () => {
        setIsLoggingOut(true);
        backend.auth.logout('/');
    };

    if (!user) {
        return (
            <Button
                onClick={() => backend.auth.redirectToLogin(window.location.href)}
                variant="outline"
                className="bg-white/[0.07] border-white/15 text-white font-semibold hover:bg-white/15 hover:text-white rounded-full"
            >
                <LogIn className="w-4 h-4 mr-2" />
                Sign in
            </Button>
        );
    }

    const name = displayNameFor(user);

    return (
        <div className="flex items-center gap-2.5 bg-white/[0.07] border border-white/10 rounded-full p-1 max-w-full">
            <div className="w-8 h-8 shrink-0 rounded-full bg-gradient-to-b from-indigo-400 to-indigo-600 ring-1 ring-amber-300/70 text-white font-bold flex items-center justify-center uppercase">
                {name.charAt(0)}
            </div>
            <div className="min-w-0 text-left leading-tight">
                <div className="text-white text-sm font-semibold truncate">{name}</div>
                <div className="text-white/70 text-xs truncate">{user.email}</div>
            </div>
            <Button
                onClick={logOut}
                disabled={isLoggingOut}
                size="sm"
                variant="ghost"
                className="shrink-0 text-white/80 hover:text-white hover:bg-white/20 rounded-full"
            >
                {isLoggingOut ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                    <LogOut className="w-4 h-4 sm:mr-1" />
                )}
                <span className="hidden sm:inline">Log out</span>
            </Button>
        </div>
    );
}

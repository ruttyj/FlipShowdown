import React from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Users } from 'lucide-react';
import { motion } from 'framer-motion';
import RoomHeader, { RulesFooter } from './RoomHeader';
import { isInAppBrowser } from '@/lib/inAppBrowser';

function InAppBrowserHint() {
    if (!isInAppBrowser(navigator.userAgent)) {
        return null;
    }

    return (
        <div className="mb-6 rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
            You seem to be inside another app's browser. For the smoothest game, open this page in
            Safari or Chrome (use the app's "Open in browser" option), so you stay signed in.
        </div>
    );
}

/** Names only: the by-code lookup gives non-members no emails. */
function PlayersInRoom({ players }) {
    if (players.length === 0) {
        return null;
    }

    return (
        <div className="mb-6 rounded-xl bg-slate-50 border border-slate-100 p-3">
            <p className="text-xs font-medium text-slate-700 mb-1">Already in this room</p>
            <p className="text-sm text-slate-800">{players.map((player) => player.name).join(', ')}</p>
            <p className="text-xs text-slate-500 mt-2">Already playing? Sign in with the same email as before</p>
        </div>
    );
}

export default function JoinScreen({ room, themeMode, roomCode, players, playerName, setPlayerName, joinRoom, isJoining }) {
    return (
        <div className="min-h-screen game-screen-bg flex flex-col items-center justify-center p-3 sm:p-6">
            <RoomHeader room={room} themeMode={themeMode} />
            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-white rounded-2xl sm:rounded-3xl p-5 sm:p-8 w-full max-w-md shadow-2xl"
            >
                <h2 className="text-2xl font-bold text-slate-800 mb-2 text-center">Join Game</h2>
                <p className="text-slate-500 text-center mb-6">Room: {roomCode}</p>

                <InAppBrowserHint />
                <PlayersInRoom players={players} />

                <div className="space-y-4">
                    <div>
                                <label className="text-xs sm:text-sm font-medium text-slate-700 mb-1 block">Your Name</label>
                                <Input
                                    value={playerName}
                                    onChange={(e) => setPlayerName(e.target.value)}
                                    placeholder="Enter your name"
                                    className="h-10 sm:h-12 text-sm sm:text-lg"
                                />
                    </div>
                    <Button
                        onClick={joinRoom}
                        disabled={isJoining || !playerName.trim()}
                        className="w-full h-12 bg-ui-accent hover:bg-ui-accent-strong"
                    >
                        {isJoining ? (
                            <Loader2 className="w-5 h-5 animate-spin mr-2" />
                        ) : (
                            <Users className="w-5 h-5 mr-2" />
                        )}
                        Join Room
                    </Button>
                </div>
            </motion.div>
            <RulesFooter room={room} />
        </div>
    );
}

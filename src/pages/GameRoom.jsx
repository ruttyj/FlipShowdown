import React from 'react';
import { Button } from "@/components/ui/button";
import { Loader2, AlertTriangle } from 'lucide-react';
import DuplicateTabNotice from '@/components/DuplicateTabNotice';
import ModeShift from '@/components/game/ModeShift';
import { useGameRoom } from './gameRoom/useGameRoom';
import JoinScreen from './gameRoom/JoinScreen';
import WaitingRoomScreen from './gameRoom/WaitingRoomScreen';
import FinishedScreen from './gameRoom/FinishedScreen';
import ActiveGameScreen from './gameRoom/ActiveGameScreen';
import RoomDialogs from './gameRoom/RoomDialogs';

const SCREEN_CLASSES = 'min-h-screen game-screen-bg flex items-center justify-center p-3 sm:p-6';

/**
 * @param {object} props
 * @param {string} props.title
 * @param {string} [props.message]
 * @param {React.ReactNode} props.children
 */
function MessageCard({ title, message, children }) {
    return (
        <div className={SCREEN_CLASSES}>
            <div className="bg-white rounded-2xl sm:rounded-3xl p-5 sm:p-8 w-full max-w-md shadow-2xl text-center">
                <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
                <h2 className="text-2xl font-bold text-slate-800 mb-2">{title}</h2>
                {message && <p className="text-slate-500 break-words">{message}</p>}
                <div className="flex flex-col gap-3 mt-6">{children}</div>
            </div>
        </div>
    );
}

export default function GameRoom() {
    const game = useGameRoom();

    return (
        <>
            {game.table.room && <DuplicateTabNotice roomId={game.table.room.id} />}
            <RoomScreen game={game} />
            <ModeShift shift={game.theme.shift} />
        </>
    );
}

/** The screen for the room's status, once I'm in it. */
function JoinedScreen({ game }) {
    const { status } = game.table.room;

    if (status === 'waiting') {
        return <WaitingRoomScreen game={game} />;
    }
    if (status === 'finished') {
        return <FinishedScreen game={game} />;
    }
    return <ActiveGameScreen game={game} />;
}

function RoomScreen({ game }) {
    const { load, table, joining, goHome } = game;

    // Before the spinner: a room that closes while a join is still running must show this,
    // not a spinner that never ends (X6).
    if (load.isRoomGone) {
        return (
            <MessageCard title="This room was closed">
                <Button onClick={goHome} className="w-full h-12 bg-ui-accent hover:bg-ui-accent-strong">
                    Back to home
                </Button>
            </MessageCard>
        );
    }

    if (load.isSigningIn || load.status === 'loading' || joining.isAutoJoining) {
        return (
            <div className={SCREEN_CLASSES}>
                <Loader2 className="w-8 h-8 animate-spin text-white" />
            </div>
        );
    }

    if (load.status === 'missing') {
        return (
            <MessageCard title="Room not found" message="Check the room code and try again.">
                <Button onClick={goHome} className="w-full h-12 bg-ui-accent hover:bg-ui-accent-strong">
                    Back to home
                </Button>
            </MessageCard>
        );
    }

    if (load.status === 'error') {
        return (
            <MessageCard title="Couldn't load the room" message={load.error?.message}>
                <Button onClick={load.retry} className="w-full h-12 bg-ui-accent hover:bg-ui-accent-strong">
                    Retry
                </Button>
                <Button variant="outline" onClick={goHome} className="w-full h-12">
                    Back to home
                </Button>
            </MessageCard>
        );
    }

    if (!table.hasJoined) {
        return (
            <JoinScreen
                room={table.room}
                themeMode={game.theme.mode}
                roomCode={table.roomCode}
                players={table.players}
                playerName={joining.name}
                setPlayerName={joining.changeName}
                joinRoom={() => joining.join(joining.name)}
                isJoining={joining.isJoining}
            />
        );
    }

    return (
        <>
            <JoinedScreen game={game} />
            <RoomDialogs game={game} />
        </>
    );
}

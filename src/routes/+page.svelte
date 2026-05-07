<script lang="ts">
    import type { PageData } from './$types';
    import { Chessground } from 'svelte-chessground';
    import { Chess } from 'chess.js';
    import { onMount } from 'svelte';

    let { data }: { data: PageData } = $props();

    let chess = new Chess();
    let fen = $state(chess.fen()); 
    let moveHistory = $state<{fen: string, san: string, lastMove?: [string, string]}[]>([]);
    let currentMoveIndex = $state(-1);
    let currentHighlight = $derived(currentMoveIndex >= 0 ? moveHistory[currentMoveIndex].lastMove : undefined);
    
    // -- NEW STATE: Store the active game and board orientation --
    let currentGame = $state<any>(null);
    let boardOrientation = $state<'white' | 'black'>('white');

    let engine: Worker;
    let evalScore = $state(0); 
    let whiteAdvantagePercent = $state(50); 
    let isEngineReady = $state(false);
    let analysisTimer: ReturnType<typeof setTimeout>;

    let explanation = $state("");
    let isThinking = $state(false);
    let lastEval = 0; 

    onMount(() => {
        engine = new Worker('/stockfish.js');
        
        engine.onmessage = (event) => {
            const line = event.data;
            if (line === 'uciok') engine.postMessage('isready');
            else if (line === 'readyok') {
                isEngineReady = true;
                analyzeCurrentPosition(); 
            }
            else if (line.includes('info depth') && line.includes('score cp')) {
                const match = line.match(/score cp (-?\d+)/);
                if (match) {
                    let cp = parseInt(match[1]);
                    const sideToMove = fen.split(' ')[1]; 
                    if (sideToMove === 'b') cp = -cp;
                    evalScore = cp;
                    whiteAdvantagePercent = 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
                }
            } else if (line.includes('score mate')) {
                const match = line.match(/score mate (-?\d+)/);
                if (match) {
                    let mateInX = parseInt(match[1]);
                    const sideToMove = fen.split(' ')[1]; 
                    if (sideToMove === 'b') mateInX = -mateInX;
                    whiteAdvantagePercent = mateInX > 0 ? 100 : 0;
                }
            }
        };
        engine.postMessage('uci');
    });

    function loadGame(game: any) {
        currentGame = game;
        chess.loadPgn(game.pgn);
        const history = chess.history({ verbose: true });
        chess.reset();
        
        moveHistory = history.map(move => {
            chess.move(move);
            return { 
                fen: chess.fen(), 
                san: move.san,
                // move.from and move.to are provided by chess.js verbose history!
                lastMove: [move.from, move.to] as [string, string] 
            };
        });
        
        currentMoveIndex = -1;
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"; 
        explanation = ""; 

        // If the search bar is empty, we figure out the owner by finding 
        // the common player between the first two games in the archive list.
        let archiveOwner = (data.currentUsername || '').toLowerCase().trim();
        
        if (!archiveOwner && data.games && data.games.length > 0) {
            if (data.games.length > 1) {
                const g1 = data.games[0];
                const g2 = data.games[1];
                const g1Players = [g1.white.username.toLowerCase(), g1.black.username.toLowerCase()];
                const g2Players = [g2.white.username.toLowerCase(), g2.black.username.toLowerCase()];
                
                // Find the player that exists in both games
                archiveOwner = g1Players.find(p => g2Players.includes(p)) || g1Players[0];
            } else {
                archiveOwner = data.games[0].white.username.toLowerCase();
            }
        }

        // Orient the board so the archive owner is always at the bottom
        if (game.black.username.toLowerCase() === archiveOwner) {
            boardOrientation = 'black';
        } else {
            boardOrientation = 'white';
        }

        analyzeCurrentPosition();
    }

    function nextMove() {
        if (currentMoveIndex < moveHistory.length - 1) {
            currentMoveIndex++;
            fen = moveHistory[currentMoveIndex].fen;
            analyzeCurrentPosition();
        }
    }

    function prevMove() {
        if (currentMoveIndex >= 0) {
            currentMoveIndex--;
            fen = currentMoveIndex >= 0 ? moveHistory[currentMoveIndex].fen : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
            analyzeCurrentPosition();
        }
    }

    function analyzeCurrentPosition() {
        if (engine && isEngineReady) {
            engine.postMessage('stop'); 
            clearTimeout(analysisTimer);
            analysisTimer = setTimeout(() => {
                engine.postMessage(`position fen ${fen}`);
                engine.postMessage('go depth 14');
            }, 300);
        }
    }

    async function askCoach() {
        isThinking = true;
        explanation = "Analyzing position...";
        const currentEvalPawn = evalScore / 100;
        const change = (currentEvalPawn - lastEval).toFixed(2);
        
        try {
            const response = await fetch('/api/explain', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fen: fen,
                    move: moveHistory[currentMoveIndex]?.san || "Start of game",
                    evalChange: change,
                    bestMove: "the engine's top choice" 
                })
            });
            const resData = await response.json();
            explanation = resData.explanation;
        } catch (error) {
            explanation = "Network error. Make sure the API is running.";
        }
        isThinking = false;
        lastEval = currentEvalPawn; 
    }
</script>

{#snippet userIcon(color: 'white' | 'black')}
    <svg width="18" height="18" viewBox="0 0 24 24" 
        fill={color === 'white' ? '#e0e0e0' : '#444'} 
        stroke={color === 'white' ? '#fff' : '#aaa'} 
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
        <circle cx="12" cy="7" r="4"></circle>
    </svg>
{/snippet}

{#snippet coachIcon()}
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4a90e2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2l10 6.5-10 6.5-10-6.5z"></path>
        <path d="M22 8.5v7"></path>
        <path d="M6 10.6V16c0 2.8 2.7 5 6 5s6-2.2 6-5v-5.4"></path>
    </svg>
{/snippet}

<main class="dashboard">
    <aside class="sidebar">
        <div class="sidebar-header">
            <h2>Player Archive</h2>
            <form method="GET" class="search-form">
                <input type="text" name="username" placeholder="Search chess.com user..." value={data.currentUsername} required />
                <button type="submit">Load</button>
            </form>
        </div>

        <div class="game-list">
            {#if data.games.length === 0}
                <div style="text-align: center; color: #777; padding: 20px;">No games found for this player.</div>
            {/if}
            {#each data.games as game}
                <button class="game-btn" onclick={() => loadGame(game)}>
                    <div class="game-date">
                        {new Date(game.end_time * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </div>
                    <div class="players">
                        <span class="player-row">
                            {@render userIcon('white')} 
                            <span class="username">{game.white.username}</span> 
                            <span class="rating">({game.white.rating})</span>
                        </span>
                        <span class="player-row">
                            {@render userIcon('black')} 
                            <span class="username">{game.black.username}</span> 
                            <span class="rating">({game.black.rating})</span>
                        </span>
                    </div>
                </button>
            {/each}
        </div>
    </aside>

    <div class="eval-container">
        <div class="eval-score">
            {evalScore > 0 ? '+' : ''}{(evalScore / 100).toFixed(2)}
        </div>
        <div class="eval-bar">
            <div class="eval-fill" style="height: {whiteAdvantagePercent}%;"></div>
        </div>
    </div>

    <div class="board-area">
        
        <div class="player-nameplate">
            {#if currentGame}
                {@const topPlayer = boardOrientation === 'white' ? currentGame.black : currentGame.white}
                {@const topColor = boardOrientation === 'white' ? 'black' : 'white'}
                {@render userIcon(topColor)}
                <span class="username">{topPlayer.username}</span>
                <span class="rating">({topPlayer.rating})</span>
            {:else}
                <span style="color: #555;">Select a game from the archive...</span>
            {/if}
        </div>

        <div class="board-wrapper">
            <div class="board-wrapper">
                <Chessground 
                    {fen} 
                    orientation={boardOrientation} 
                    lastMove={currentHighlight as any} 
                />
            </div>
        </div>
        
        <div class="player-nameplate">
            {#if currentGame}
                {@const botPlayer = boardOrientation === 'white' ? currentGame.white : currentGame.black}
                {@const botColor = boardOrientation === 'white' ? 'white' : 'black'}
                {@render userIcon(botColor)}
                <span class="username">{botPlayer.username}</span>
                <span class="rating">({botPlayer.rating})</span>
            {/if}
        </div>

        <div class="controls">
            <button class="nav-btn" onclick={prevMove}>&larr; Prev</button>
            <div class="move-counter">
                Move: {currentMoveIndex + 1} / {moveHistory.length}
            </div>
            <button class="nav-btn" onclick={nextMove}>Next &rarr;</button>
        </div>

        <div class="coach-card">
            <div class="coach-header">
                <h3 style="display: flex; align-items: center; gap: 8px;">
                    {@render coachIcon()} AI Coach
                </h3>
                <button class="coach-btn" onclick={askCoach} disabled={isThinking}>
                    {isThinking ? "Thinking..." : "Explain Move"}
                </button>
            </div>
            <p class="coach-text">
                {explanation || "Select a move and ask the coach for an evaluation."}
            </p>
        </div>
    </div>
</main>

<style>
    /* ... (Keep all your existing CSS the same down to .board-area) ... */

    :global(body) {
        margin: 0;
        background-color: #121212;
        color: #e0e0e0;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    .dashboard {
        display: flex;
        gap: 30px;
        padding: 40px;
        max-width: 1200px;
        margin: 0 auto;
        min-height: 100vh;
        box-sizing: border-box;
    }

    .sidebar {
        width: 320px;
        background: #1e1e1e;
        padding: 20px;
        border-radius: 12px;
        box-shadow: 0 8px 16px rgba(0,0,0,0.4);
        display: flex;
        flex-direction: column;
        border: 1px solid #2a2a2a;
    }

    .sidebar-header h2 {
        margin-top: 0;
        font-size: 1.1rem;
        color: #a0a0a0;
        text-transform: uppercase;
        letter-spacing: 1px;
    }

    .search-form {
        display: flex;
        gap: 8px;
        margin-bottom: 20px;
        border-bottom: 1px solid #2a2a2a;
        padding-bottom: 20px;
    }

    .search-form input {
        flex-grow: 1;
        padding: 10px;
        background: #121212;
        border: 1px solid #333;
        border-radius: 6px;
        color: white;
        outline: none;
    }

    .search-form input:focus { border-color: #4a90e2; }

    .search-form button {
        background: #4a90e2;
        color: white;
        border: none;
        padding: 10px 15px;
        border-radius: 6px;
        cursor: pointer;
        font-weight: bold;
    }

    .search-form button:hover { background: #357abd; }

    .game-list {
        overflow-y: auto;
        flex-grow: 1;
        max-height: 70vh;
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding-right: 5px;
    }

    .game-list::-webkit-scrollbar { width: 6px; }
    .game-list::-webkit-scrollbar-track { background: transparent; }
    .game-list::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }

    .game-btn {
        width: 100%;
        text-align: left;
        padding: 12px 15px;
        cursor: pointer;
        background: #252526;
        border: 1px solid #333;
        border-radius: 8px;
        color: #ddd;
        transition: all 0.2s ease;
    }

    .game-btn:hover {
        background: #2d2d30;
        border-color: #4a4a4a;
        transform: translateY(-1px);
    }

    .game-date {
        font-size: 0.75rem;
        color: #888;
        margin-bottom: 8px;
        text-align: right;
    }

    .players {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .player-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.95rem;
    }

    .username { font-weight: 500; }
    .rating { color: #888; font-size: 0.8rem; }

    .eval-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 15px;
        padding-top: 45px; /* Offset to account for the top player nameplate */
    }

    .eval-score {
        font-weight: 600;
        font-family: monospace;
        font-size: 1.1rem;
        background: #1e1e1e;
        padding: 5px 10px;
        border-radius: 6px;
        border: 1px solid #333;
    }

    .eval-bar {
        width: 24px;
        height: 512px; 
        background: #222; 
        border-radius: 6px;
        overflow: hidden;
        display: flex;
        flex-direction: column-reverse;
        border: 2px solid #333;
        box-shadow: inset 0 0 10px rgba(0,0,0,0.5);
    }

    .eval-fill {
        width: 100%;
        background: #e0e0e0; 
        transition: height 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .board-area {
        flex-grow: 1;
        max-width: 512px;
        display: flex;
        flex-direction: column;
        gap: 15px;
    }

    /* NEW STYLES FOR THE PLAYER NAMEPLATES */
    .player-nameplate {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 1.1rem;
        padding: 5px 10px;
        height: 24px;
        background: #181818;
        border-radius: 6px;
    }

    .board-wrapper {
        width: 512px;
        height: 512px;
        box-shadow: 0 12px 24px rgba(0,0,0,0.5);
        border-radius: 4px;
        overflow: hidden;
    }

    .controls {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #1e1e1e;
        padding: 15px 20px;
        border-radius: 12px;
        border: 1px solid #2a2a2a;
    }

    .move-counter { font-weight: 600; color: #aaa; }

    .nav-btn {
        background: #333;
        color: #fff;
        border: none;
        padding: 10px 20px;
        border-radius: 6px;
        cursor: pointer;
        font-weight: 600;
        transition: background 0.2s;
    }

    .nav-btn:hover { background: #444; }

    .coach-card {
        background: linear-gradient(145deg, #1e1e1e, #1a1a1a);
        padding: 20px;
        border-radius: 12px;
        border: 1px solid #2a2a2a;
        border-left: 4px solid #4a90e2; 
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }

    .coach-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 15px;
    }

    .coach-header h3 { margin: 0; color: #4a90e2; font-size: 1.1rem; }

    .coach-btn {
        background: #4a90e2;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 6px;
        cursor: pointer;
        font-weight: 600;
        transition: background 0.2s, transform 0.1s;
    }

    .coach-btn:hover:not(:disabled) { background: #357abd; }
    .coach-btn:disabled { background: #333; color: #777; cursor: not-allowed; }

    .coach-text { color: #ccc; line-height: 1.6; margin: 0; font-style: italic; }
</style>
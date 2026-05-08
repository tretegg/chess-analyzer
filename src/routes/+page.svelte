<script lang="ts">
    import type { PageData } from './$types';
    import { Chessground } from 'svelte-chessground';
    import { Chess } from 'chess.js';
    import { onMount } from 'svelte';

    let { data }: { data: PageData } = $props();

    let chess = new Chess();
    let fen = $state(chess.fen()); 
    
    interface MoveRecord {
        fen: string;
        san: string;
        lastMove?: [string, string];
        eval?: number; 
        classification?: 'blunder' | 'mistake' | 'inaccuracy' | 'good';
    }
    let moveHistory = $state<MoveRecord[]>([]);
    let currentMoveIndex = $state(-1);
    
    let pairedMoves = $derived.by(() => {
        const pairs = [];
        for (let i = 0; i < moveHistory.length; i += 2) {
            pairs.push({
                moveNumber: Math.floor(i / 2) + 1,
                whiteIndex: i,
                white: moveHistory[i],
                blackIndex: i + 1,
                black: moveHistory[i + 1] || null
            });
        }
        return pairs;
    });

    let currentHighlight = $derived(currentMoveIndex >= 0 ? moveHistory[currentMoveIndex].lastMove : undefined);
    
    let currentGame = $state<any>(null);
    let boardOrientation = $state<'white' | 'black'>('white');

    // -- FOREGROUND ENGINE (Deep analysis + Arrows) --
    let engine: Worker;
    let evalScore = $state(0); 
    let whiteAdvantagePercent = $state(50); 
    let isEngineReady = $state(false);
    let analysisTimer: ReturnType<typeof setTimeout>;
    
    // -- BEST MOVE ARROWS --
    let bestMoveShape = $state<any[]>([]); 
    let bestMoveString = $state("");

    // -- BACKGROUND ENGINE (Full Game Pre-Analysis) --
    let bgEngine: Worker;
    let bgMoveIndex = $state(0);
    let isAnalyzingGame = $state(false);

    let explanation = $state("");
    let isThinking = $state(false);

    onMount(() => {
        // 1. Setup Foreground Engine
        engine = new Worker('/stockfish.js');
        engine.onmessage = (event) => {
            const line = event.data;
            if (line === 'uciok') engine.postMessage('isready');
            else if (line === 'readyok') {
                isEngineReady = true;
                analyzeCurrentPosition(); 
            }
            
            // Extract the Best Move Arrow from the PV (Principal Variation)
            const pvMatch = line.match(/ pv ([a-h][1-8])([a-h][1-8])/);
            if (pvMatch) {
                bestMoveString = pvMatch[1] + pvMatch[2]; // e.g. "e2e4"
                bestMoveShape = [{ orig: pvMatch[1], dest: pvMatch[2], brush: 'paleGreen' }];
            }

            if (line.includes('score cp')) {
                const match = line.match(/score cp (-?\d+)/);
                if (match) {
                    let cp = parseInt(match[1]);
                    const sideToMove = fen.split(' ')[1]; 
                    const absoluteCp = sideToMove === 'b' ? -cp : cp; 
                    
                    evalScore = absoluteCp;
                    whiteAdvantagePercent = 50 + 50 * (2 / (1 + Math.exp(-0.004 * absoluteCp)) - 1);
                }
            }
        };
        engine.postMessage('uci');

        // 2. Setup Background Engine for Pre-Analysis
        bgEngine = new Worker('/stockfish.js');
        bgEngine.onmessage = (event) => {
            const line = event.data;
            if (line === 'uciok') bgEngine.postMessage('isready');
            
            if (line.includes('score cp') && isAnalyzingGame) {
                const match = line.match(/score cp (-?\d+)/);
                if (match && bgMoveIndex >= 0 && bgMoveIndex < moveHistory.length) {
                    let cp = parseInt(match[1]);
                    const sideToMove = moveHistory[bgMoveIndex].fen.split(' ')[1]; 
                    const absoluteCp = sideToMove === 'b' ? -cp : cp; 
                    
                    moveHistory[bgMoveIndex].eval = absoluteCp;

                    if (bgMoveIndex > 0 && moveHistory[bgMoveIndex - 1].eval !== undefined) {
                        const prevEval = moveHistory[bgMoveIndex - 1].eval!;
                        const diff = absoluteCp - prevEval;

                        // Accurate pawn loss based on who just moved
                        let pawnLoss = sideToMove === 'w' ? diff / 100 : -diff / 100;

                        let classification: MoveRecord['classification'] = 'good';
                        if (pawnLoss >= 2.0) classification = 'blunder';
                        else if (pawnLoss >= 1.0) classification = 'mistake';
                        else if (pawnLoss >= 0.5) classification = 'inaccuracy';

                        moveHistory[bgMoveIndex].classification = classification;
                    }
                }
            }

            // When background engine finds the best move, advance to the next move!
            if (line.includes('bestmove') && isAnalyzingGame) {
                bgMoveIndex++;
                if (bgMoveIndex < moveHistory.length) {
                    bgEngine.postMessage(`position fen ${moveHistory[bgMoveIndex].fen}`);
                    bgEngine.postMessage('go depth 10'); // Fast depth for background
                } else {
                    isAnalyzingGame = false; // Finished analyzing whole game!
                }
            }
        };
        bgEngine.postMessage('uci');
    });

    function loadGame(game: any) {
        currentGame = game;
        chess.loadPgn(game.pgn);
        const history = chess.history({ verbose: true });
        chess.reset();
        
        moveHistory = history.map(move => {
            chess.move(move);
            return { fen: chess.fen(), san: move.san, lastMove: [move.from, move.to] as [string, string] };
        });
        
        currentMoveIndex = -1;
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"; 
        explanation = ""; 
        bestMoveShape = [];

        let archiveOwner = (data.currentUsername || '').toLowerCase().trim();
        if (!archiveOwner && data.games && data.games.length > 0) {
            if (data.games.length > 1) {
                const g1 = data.games[0];
                const g2 = data.games[1];
                const g1Players = [g1.white.username.toLowerCase(), g1.black.username.toLowerCase()];
                const g2Players = [g2.white.username.toLowerCase(), g2.black.username.toLowerCase()];
                archiveOwner = g1Players.find(p => g2Players.includes(p)) || g1Players[0];
            } else {
                archiveOwner = data.games[0].white.username.toLowerCase();
            }
        }

        if (game.black.username.toLowerCase() === archiveOwner) boardOrientation = 'black';
        else boardOrientation = 'white';

        analyzeCurrentPosition();

        // 3. START FULL GAME PRE-ANALYSIS
        bgEngine.postMessage('stop');
        isAnalyzingGame = true;
        bgMoveIndex = 0;
        bgEngine.postMessage(`position fen ${fen}`);
        bgEngine.postMessage('go depth 10');
    }

    function goToMove(index: number) {
        if (index >= -1 && index < moveHistory.length) {
            currentMoveIndex = index;
            fen = index >= 0 ? moveHistory[index].fen : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
            bestMoveShape = []; // Clear old arrow
            analyzeCurrentPosition();
        }
    }

    function nextMove() { goToMove(currentMoveIndex + 1); }
    function prevMove() { goToMove(currentMoveIndex - 1); }

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
        const change = currentMoveIndex > 0 ? (evalScore / 100) - (moveHistory[currentMoveIndex - 1].eval! / 100) : 0;
        
        try {
            const response = await fetch('/api/explain', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fen: fen,
                    move: moveHistory[currentMoveIndex]?.san || "Start of game",
                    evalChange: change.toFixed(2),
                    bestMove: bestMoveString // Pass the engine's actual best move to the AI!
                })
            });
            const resData = await response.json();
            explanation = resData.explanation;
        } catch (error) {
            explanation = "Network error. Make sure the API is running.";
        }
        isThinking = false;
    }
</script>

{#snippet userIcon(color: 'white' | 'black')}
    <svg width="18" height="18" viewBox="0 0 24 24" fill={color === 'white' ? '#e0e0e0' : '#444'} stroke={color === 'white' ? '#fff' : '#aaa'} stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>
    </svg>
{/snippet}

{#snippet coachIcon()}
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4a90e2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2l10 6.5-10 6.5-10-6.5z"></path><path d="M22 8.5v7"></path><path d="M6 10.6V16c0 2.8 2.7 5 6 5s6-2.2 6-5v-5.4"></path>
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
            {#each data.games as game}
                <button class="game-btn" onclick={() => loadGame(game)}>
                    <div class="game-date">{new Date(game.end_time * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                    <div class="players">
                        <span class="player-row">{@render userIcon('white')} <span class="username">{game.white.username}</span> <span class="rating">({game.white.rating})</span></span>
                        <span class="player-row">{@render userIcon('black')} <span class="username">{game.black.username}</span> <span class="rating">({game.black.rating})</span></span>
                    </div>
                </button>
            {/each}
        </div>
    </aside>

    <div class="eval-container">
        <div class="eval-score">{evalScore > 0 ? '+' : ''}{(evalScore / 100).toFixed(2)}</div>
        <div class="eval-bar"><div class="eval-fill" style="height: {whiteAdvantagePercent}%;"></div></div>
    </div>

    <div class="board-area">
        <div class="player-nameplate">
            {#if currentGame}
                {@const topPlayer = boardOrientation === 'white' ? currentGame.black : currentGame.white}
                {@const topColor = boardOrientation === 'white' ? 'black' : 'white'}
                {@render userIcon(topColor)} <span class="username">{topPlayer.username}</span> <span class="rating">({topPlayer.rating})</span>
            {/if}
        </div>

        <div class="board-wrapper">
            <Chessground {fen} orientation={boardOrientation} lastMove={currentHighlight as any} drawable={{ autoShapes: bestMoveShape }} />
        </div>
        
        <div class="player-nameplate">
            {#if currentGame}
                {@const botPlayer = boardOrientation === 'white' ? currentGame.white : currentGame.black}
                {@const botColor = boardOrientation === 'white' ? 'white' : 'black'}
                {@render userIcon(botColor)} <span class="username">{botPlayer.username}</span> <span class="rating">({botPlayer.rating})</span>
            {/if}
        </div>

        <div class="coach-card">
            <div class="coach-header">
                <h3 style="display: flex; align-items: center; gap: 8px;">{@render coachIcon()} AI Coach</h3>
                <button class="coach-btn" onclick={askCoach} disabled={isThinking}>{isThinking ? "Thinking..." : "Explain Move"}</button>
            </div>
            <p class="coach-text">{explanation || "Select a move and ask the coach for an evaluation."}</p>
        </div>
    </div>

    <div class="notation-panel">
        <div class="controls">
            <button class="nav-btn" onclick={prevMove}>&larr;</button>
            <div class="move-counter">Move {currentMoveIndex + 1}</div>
            <button class="nav-btn" onclick={nextMove}>&rarr;</button>
        </div>
        
        {#if isAnalyzingGame}
            <div class="analysis-progress">
                Analyzing Game: {bgMoveIndex} / {moveHistory.length}
                <div class="progress-bar"><div class="progress-fill" style="width: {(bgMoveIndex / moveHistory.length) * 100}%;"></div></div>
            </div>
        {:else if currentGame}
            <div class="analysis-complete">✓ Full game analyzed</div>
        {/if}

        <div class="moves-grid">
            {#each pairedMoves as pair}
                <div class="move-row">
                    <div class="move-num">{pair.moveNumber}.</div>
                    <button class="move-btn {currentMoveIndex === pair.whiteIndex ? 'active' : ''}" onclick={() => goToMove(pair.whiteIndex)}>
                        {pair.white.san}
                        {#if pair.white.classification === 'blunder'}<span class="badge blunder">??</span>
                        {:else if pair.white.classification === 'mistake'}<span class="badge mistake">?</span>
                        {:else if pair.white.classification === 'inaccuracy'}<span class="badge inaccuracy">?!</span>{/if}
                    </button>
                    {#if pair.black}
                        <button class="move-btn {currentMoveIndex === pair.blackIndex ? 'active' : ''}" onclick={() => goToMove(pair.blackIndex)}>
                            {pair.black.san}
                            {#if pair.black.classification === 'blunder'}<span class="badge blunder">??</span>
                            {:else if pair.black.classification === 'mistake'}<span class="badge mistake">?</span>
                            {:else if pair.black.classification === 'inaccuracy'}<span class="badge inaccuracy">?!</span>{/if}
                        </button>
                    {/if}
                </div>
            {/each}
        </div>
    </div>
</main>

<style>
    /* Additions for the Progress Bar */
    .analysis-progress {
        font-size: 0.8rem; color: #aaa; text-align: center; padding: 10px; background: #222; border-bottom: 1px solid #333;
    }
    .progress-bar {
        height: 4px; background: #333; border-radius: 2px; margin-top: 5px; overflow: hidden;
    }
    .progress-fill {
        height: 100%; background: #4a90e2; transition: width 0.2s linear;
    }
    .analysis-complete {
        font-size: 0.8rem; color: #4CAF50; text-align: center; padding: 10px; background: #1a2e1a; border-bottom: 1px solid #333; font-weight: bold;
    }

    /* ... KEEP ALL YOUR EXISTING CSS FROM PREVIOUS STEPS DOWN HERE ... */
    .notation-panel { width: 300px; background: #1e1e1e; border-radius: 12px; border: 1px solid #2a2a2a; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 16px rgba(0,0,0,0.4); }
    .moves-grid { flex-grow: 1; overflow-y: auto; padding: 10px; max-height: calc(100vh - 150px); }
    .moves-grid::-webkit-scrollbar { width: 6px; }
    .moves-grid::-webkit-scrollbar-track { background: transparent; }
    .moves-grid::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
    .move-row { display: flex; align-items: center; padding: 4px 0; border-bottom: 1px solid #252525; }
    .move-num { width: 40px; color: #777; font-family: monospace; font-size: 0.9rem; text-align: right; padding-right: 10px; }
    .move-btn { flex: 1; background: transparent; border: none; color: #ccc; text-align: left; padding: 8px 10px; cursor: pointer; font-weight: 500; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; transition: background 0.2s; }
    .move-btn:hover { background: #2a2a2a; color: #fff; }
    .move-btn.active { background: #354e6b; color: #fff; }
    .badge { font-size: 0.75rem; font-weight: 800; padding: 2px 6px; border-radius: 12px; color: white; }
    .blunder { background: #e74c3c; }
    .mistake { background: #e67e22; }
    .inaccuracy { background: #f1c40f; color: #333; }
    :global(body) { margin: 0; background-color: #121212; color: #e0e0e0; font-family: 'Inter', sans-serif; }
    .dashboard { display: flex; gap: 30px; padding: 40px; max-width: 1400px; margin: 0 auto; min-height: 100vh; box-sizing: border-box; }
    .sidebar { width: 320px; background: #1e1e1e; padding: 20px; border-radius: 12px; box-shadow: 0 8px 16px rgba(0,0,0,0.4); display: flex; flex-direction: column; border: 1px solid #2a2a2a; }
    .sidebar-header h2 { margin-top: 0; font-size: 1.1rem; color: #a0a0a0; text-transform: uppercase; letter-spacing: 1px; }
    .search-form { display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 1px solid #2a2a2a; padding-bottom: 20px; }
    .search-form input { flex-grow: 1; padding: 10px; background: #121212; border: 1px solid #333; border-radius: 6px; color: white; outline: none; }
    .search-form input:focus { border-color: #4a90e2; }
    .search-form button { background: #4a90e2; color: white; border: none; padding: 10px 15px; border-radius: 6px; cursor: pointer; font-weight: bold; }
    .search-form button:hover { background: #357abd; }
    .game-list { overflow-y: auto; flex-grow: 1; max-height: 70vh; display: flex; flex-direction: column; gap: 10px; padding-right: 5px; }
    .game-list::-webkit-scrollbar { width: 6px; }
    .game-list::-webkit-scrollbar-track { background: transparent; }
    .game-list::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
    .game-btn { width: 100%; text-align: left; padding: 12px 15px; cursor: pointer; background: #252526; border: 1px solid #333; border-radius: 8px; color: #ddd; transition: all 0.2s ease; }
    .game-btn:hover { background: #2d2d30; border-color: #4a4a4a; transform: translateY(-1px); }
    .game-date { font-size: 0.75rem; color: #888; margin-bottom: 8px; text-align: right; }
    .players { display: flex; flex-direction: column; gap: 6px; }
    .player-row { display: flex; align-items: center; gap: 8px; font-size: 0.95rem; }
    .username { font-weight: 500; }
    .rating { color: #888; font-size: 0.8rem; }
    .eval-container { display: flex; flex-direction: column; align-items: center; gap: 15px; padding-top: 45px; }
    .eval-score { font-weight: 600; font-family: monospace; font-size: 1.1rem; background: #1e1e1e; padding: 5px 10px; border-radius: 6px; border: 1px solid #333; }
    .eval-bar { width: 24px; height: 512px; background: #222; border-radius: 6px; overflow: hidden; display: flex; flex-direction: column-reverse; border: 2px solid #333; box-shadow: inset 0 0 10px rgba(0,0,0,0.5); }
    .eval-fill { width: 100%; background: #e0e0e0; transition: height 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
    .board-area { flex-grow: 1; max-width: 512px; display: flex; flex-direction: column; gap: 15px; }
    .player-nameplate { display: flex; align-items: center; gap: 10px; font-size: 1.1rem; padding: 5px 10px; height: 24px; background: #181818; border-radius: 6px; }
    .board-wrapper { width: 512px; height: 512px; box-shadow: 0 12px 24px rgba(0,0,0,0.5); border-radius: 4px; overflow: hidden; }
    .controls { display: flex; justify-content: space-between; align-items: center; background: #1e1e1e; padding: 15px 20px; border-bottom: 1px solid #2a2a2a; }
    .move-counter { font-weight: 600; color: #aaa; }
    .nav-btn { background: #333; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; transition: background 0.2s; }
    .nav-btn:hover { background: #444; }
    .coach-card { background: linear-gradient(145deg, #1e1e1e, #1a1a1a); padding: 20px; border-radius: 12px; border: 1px solid #2a2a2a; border-left: 4px solid #4a90e2; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    .coach-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
    .coach-header h3 { margin: 0; color: #4a90e2; font-size: 1.1rem; }
    .coach-btn { background: #4a90e2; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; transition: background 0.2s, transform 0.1s; }
    .coach-btn:hover:not(:disabled) { background: #357abd; }
    .coach-btn:disabled { background: #333; color: #777; cursor: not-allowed; }
    .coach-text { color: #ccc; line-height: 1.6; margin: 0; font-style: italic; }
</style>
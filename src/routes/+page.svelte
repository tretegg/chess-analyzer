<script lang="ts">
    import type { PageData } from './$types';
    import { Chessground } from 'svelte-chessground';
    import { Chess } from 'chess.js';
    import { onMount } from 'svelte';

    let { data }: { data: PageData } = $props();

    let chess = new Chess();
    let fen = $state(chess.fen());

    // 1. REDUCED POSITIVE CATEGORIES
    interface MoveRecord {
        fen: string;
        san: string;
        lastMove?: [string, string];
        eval?: number; 
        classification?: 'brilliant' | 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';
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

    let engine: Worker;
    let evalScore = $state(0); 
    let whiteAdvantagePercent = $state(50); 
    let isEngineReady = $state(false);
    let analysisTimer: ReturnType<typeof setTimeout>;

    let bestMoveString = $state("");
    let drawableConfig = $derived({ enabled: true, visible: true });

    let bgEngine: Worker;
    let bgMoveIndex = $state(0);
    let isAnalyzingGame = $state(false);
    let bgSessionId = $state(0); 
    let startEval = $state(0);

    let explanation = $state("");
    let isThinking = $state(false);

    let currentClassification = $derived(currentMoveIndex >= 0 ? moveHistory[currentMoveIndex]?.classification : null);
    let currentSan = $derived(currentMoveIndex >= 0 ? moveHistory[currentMoveIndex]?.san : null);

    let moveStatusText = $derived.by(() => {
        if (currentClassification && currentSan) {
            if (['brilliant', 'best', 'good'].includes(currentClassification)) {
                return `${currentSan} is ${currentClassification === 'best' ? 'the best move' : currentClassification}!`;
            }
            if (currentClassification === 'inaccuracy') {
                return `${currentSan} is an inaccuracy!`;
            }
            return `${currentSan} is a ${currentClassification}!`;
        }
        return "";
    });

    onMount(() => {
        engine = new Worker('/stockfish.js');
        engine.onmessage = (event) => {
            const line = event.data;
            if (line === 'uciok') engine.postMessage('isready');
            else if (line === 'readyok') {
                isEngineReady = true;
                analyzeCurrentPosition(); 
            }
            
            const pvMatch = line.match(/ pv (.*)/);
            if (pvMatch) {
                // Captures the entire sequence of best future moves (e.g. "e2e4 e7e5 g1f3")
                bestMoveString = pvMatch[1].trim(); 
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

        bgEngine = new Worker('/stockfish.js');
        bgEngine.onmessage = (event) => {
            const line = event.data;
            if (line === 'uciok') bgEngine.postMessage('isready');
            
            if ((line.includes('score cp') || line.includes('score mate')) && isAnalyzingGame) {
                const cpMatch = line.match(/score cp (-?\d+)/);
                const mateMatch = line.match(/score mate (-?\d+)/);
                
                if ((cpMatch || mateMatch) && bgMoveIndex >= -1 && bgMoveIndex < moveHistory.length) {
                    let cp = 0;
                    if (cpMatch) {
                        cp = parseInt(cpMatch[1]);
                    } else if (mateMatch) {
                        const mateIn = parseInt(mateMatch[1]);
                        cp = mateIn > 0 ? 10000 - mateIn * 10 : -10000 - mateIn * 10;
                    }

                    let absoluteCp;
                    if (bgMoveIndex === -1) {
                        startEval = cp; // Store the start position baseline
                    } else {
                        const sideToMove = moveHistory[bgMoveIndex].fen.split(' ')[1]; 
                        absoluteCp = sideToMove === 'b' ? -cp : cp; 
                        
                        moveHistory[bgMoveIndex].eval = absoluteCp;

                        // Compare against startEval for the first move, otherwise use previous move
                        const prevEval = bgMoveIndex === 0 ? startEval : moveHistory[bgMoveIndex - 1].eval;
                        
                        if (prevEval !== undefined) {
                            const diff = absoluteCp - prevEval;
                            let pawnLoss = sideToMove === 'w' ? diff / 100 : -diff / 100;
                            let classification: MoveRecord['classification'] = 'good';
                            
                            if (pawnLoss <= -1.0) classification = 'brilliant';
                            else if (pawnLoss <= 0.05) classification = 'best'; 
                            else if (pawnLoss <= 0.5) classification = 'good';
                            else if (pawnLoss <= 1.0) classification = 'inaccuracy';
                            else if (pawnLoss <= 2.0) classification = 'mistake';
                            else classification = 'blunder';

                            moveHistory[bgMoveIndex].classification = classification;
                        }
                    }
                }
            }

            if (line.includes('bestmove') && isAnalyzingGame) {
                bgMoveIndex++;
                if (bgMoveIndex < moveHistory.length) {
                    bgEngine.postMessage(`position fen ${moveHistory[bgMoveIndex].fen}`);
                    bgEngine.postMessage('go depth 10'); 
                } else {
                    isAnalyzingGame = false;
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

        bgEngine.postMessage('stop');
        isAnalyzingGame = false; 
        
        const currentBgSession = ++bgSessionId;
        setTimeout(() => {
            if (bgSessionId === currentBgSession) {
                isAnalyzingGame = true;
                bgMoveIndex = -1; // CHANGE THIS FROM 0 TO -1
                bgEngine.postMessage(`position fen ${fen}`);
                bgEngine.postMessage('go depth 10');
            }
        }, 150);
    }

    function goToMove(index: number) {
        if (index >= -1 && index < moveHistory.length) {
            currentMoveIndex = index;
            fen = index >= 0 ? moveHistory[index].fen : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
            explanation = "";
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
            // Get the last 4 moves leading up to this position for context
            const recentMoves = moveHistory
                .slice(Math.max(0, currentMoveIndex - 3), currentMoveIndex + 1)
                .map(m => m.san).join(" ");

            const response = await fetch('/api/explain', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fen: fen,
                    movePlayed: moveHistory[currentMoveIndex]?.san || "Start of game",
                    recentMoves: recentMoves,
                    evalChange: change.toFixed(2),
                    engineLine: bestMoveString
                })
            });
            
            const resData = await response.json();
            explanation = resData.explanation;
        } catch (error) {
            explanation = "Network error. Make sure the API is running.";
        }
        isThinking = false;
    }

    // Calculate the points for the chess.com style advantage graph
    let graphPolygon = $derived.by(() => {
        if (moveHistory.length === 0) return "0,50 100,50 100,100 0,100";
        let pts = [];
        const total = moveHistory.length;
        
        // Start position eval Y coordinate
        let startWp = 50 + 50 * (2 / (1 + Math.exp(-0.004 * startEval)) - 1);
        let startY = 100 - startWp;
        pts.push(`0,${startY}`);

        for(let i = 0; i < total; i++) {
            let cp = moveHistory[i].eval !== undefined ? moveHistory[i].eval! : startEval;
            let wp = 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
            let x = ((i + 1) / total) * 100;
            let y = 100 - wp;
            pts.push(`${x},${y}`);
        }

        // Close polygon to fill the bottom (Black's) area
        pts.push(`100,100`);
        pts.push(`0,100`);
        return pts.join(" ");
    });

    function handleGraphClick(event: MouseEvent) {
        if (moveHistory.length === 0) return;
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        const x = event.clientX - rect.left;
        const percentage = x / rect.width;
        
        const totalSteps = moveHistory.length; 
        const targetStep = Math.round(percentage * totalSteps);
        goToMove(targetStep - 1);
    }
</script>

{#snippet userIcon(color: 'white' | 'black')}
    <svg width="20" height="20" viewBox="0 0 24 24" fill={color === 'white' ? '#f1f5f9' : '#334155'} stroke={color === 'white' ? '#cbd5e1' : '#1e293b'} stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>
    </svg>
{/snippet}

{#snippet coachIcon()}
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
                <button class="game-btn {currentGame?.url === game.url ? 'active-game' : ''}" onclick={() => loadGame(game)}>
                    <div class="game-date">{new Date(game.end_time * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                    <div class="players">
                        <span class="player-row">{@render userIcon('white')} <span class="username">{game.white.username}</span> <span class="rating">({game.white.rating})</span></span>
                        <span class="player-row">{@render userIcon('black')} <span class="username">{game.black.username}</span> <span class="rating">({game.black.rating})</span></span>
                    </div>
                </button>
            {/each}
        </div>
    </aside>

    <section class="main-stage">
        <div class="player-nameplate">
            {#if currentGame}
                {@const topPlayer = boardOrientation === 'white' ? currentGame.black : currentGame.white}
                {@const topColor = boardOrientation === 'white' ? 'black' : 'white'}
                {@render userIcon(topColor)} 
                <span class="username">{topPlayer.username}</span> 
                <span class="rating">({topPlayer.rating})</span>
            {:else}
                <span class="placeholder-text">Select a game from the archive to begin</span>
            {/if}
        </div>

        <div class="board-layout">
            <div class="eval-bar">
                <div class="eval-score-pill">{evalScore > 0 ? '+' : ''}{(evalScore / 100).toFixed(1)}</div>
                <div class="eval-fill" style="height: {whiteAdvantagePercent}%;"></div>
            </div>
            <div class="board-wrapper">
                <Chessground {fen} orientation={boardOrientation} lastMove={currentHighlight as any} drawable={drawableConfig} />
            </div>
        </div>

        <div class="graph-container">
            <button class="graph-btn" aria-label="Evaluation Graph" onclick={handleGraphClick}>
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="eval-svg">
                    <rect x="0" y="0" width="100" height="100" fill="#334155" />
                    <polygon points={graphPolygon} fill="#f1f5f9" />
                    
                    <line x1="0" y1="50" x2="100" y2="50" stroke="#64748b" stroke-width="0.5" stroke-dasharray="2,2" />

                    {#if currentMoveIndex >= -1}
                        <line 
                            x1={((currentMoveIndex + 1) / Math.max(1, moveHistory.length)) * 100} 
                            y1="0" 
                            x2={((currentMoveIndex + 1) / Math.max(1, moveHistory.length)) * 100} 
                            y2="100" 
                            stroke="#3b82f6" 
                            stroke-width="1.5" />
                    {/if}
                </svg>
            </button>
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
    </section>

    <aside class="analysis-hub">
        <div class="coach-card">
            <div class="coach-header">
                <h3>{@render coachIcon()} AI Coach</h3>
                <button class="coach-btn" onclick={askCoach} disabled={!currentGame || isThinking}>{isThinking ? "Thinking..." : "Explain Move"}</button>
            </div>
            
            {#if moveStatusText}
                <div class="move-status-text {currentClassification}">
                    {moveStatusText}
                </div>
            {/if}
            <p class="coach-text">{explanation || "Click 'Explain Move' to get grandmaster feedback on this position."}</p>
        </div>

        <div class="notation-panel">
            <div class="controls">
                <button class="nav-btn" onclick={prevMove}>&larr; Prev</button>
                <div class="move-counter">
                    {currentMoveIndex >= 0 
                        ? `Move ${Math.floor(currentMoveIndex / 2) + 1} (${currentMoveIndex % 2 === 0 ? 'White' : 'Black'})` 
                        : 'Start Position'}
                </div>
                <button class="nav-btn" onclick={nextMove}>Next &rarr;</button>
            </div>
            
            {#if isAnalyzingGame}
                <div class="analysis-progress">
                    <div class="progress-text">Analyzing Game: {bgMoveIndex} / {moveHistory.length}</div>
                    <div class="progress-bar"><div class="progress-fill" style="width: {(bgMoveIndex / moveHistory.length) * 100}%;"></div></div>
                </div>
            {:else if currentGame}
                <div class="analysis-complete">✓ Game Analysis Complete</div>
            {/if}

            <div class="moves-grid">
                {#each pairedMoves as pair}
                    <div class="move-row">
                        <div class="move-num">{pair.moveNumber}.</div>
                        
                        <button class="move-btn {currentMoveIndex === pair.whiteIndex ? 'active' : ''}" onclick={() => goToMove(pair.whiteIndex)}>
                            <span class="san-text">{pair.white.san}</span>
                            
                            {#if pair.white.eval !== undefined}
                                <span class="eval-text">{pair.white.eval > 0 ? '+' : ''}{(pair.white.eval / 100).toFixed(2)}</span>
                            {/if}

                            {#if pair.white.classification === 'blunder'}<span class="badge blunder">??</span>
                            {:else if pair.white.classification === 'mistake'}<span class="badge mistake">?</span>
                            {:else if pair.white.classification === 'inaccuracy'}<span class="badge inaccuracy">?!</span>
                            {:else if pair.white.classification === 'brilliant'}<span class="badge brilliant">!!</span>
                            {:else if pair.white.classification === 'best'}<span class="badge best">★</span>
                            {:else if pair.white.classification === 'good'}<span class="badge good">✓</span>{/if}
                        </button>

                        {#if pair.black}
                            <button class="move-btn {currentMoveIndex === pair.blackIndex ? 'active' : ''}" onclick={() => goToMove(pair.blackIndex)}>
                                <span class="san-text">{pair.black.san}</span>
                                
                                {#if pair.black.eval !== undefined}
                                    <span class="eval-text">{pair.black.eval > 0 ? '+' : ''}{(pair.black.eval / 100).toFixed(2)}</span>
                                {/if}

                                {#if pair.black.classification === 'blunder'}<span class="badge blunder">??</span>
                                {:else if pair.black.classification === 'mistake'}<span class="badge mistake">?</span>
                                {:else if pair.black.classification === 'inaccuracy'}<span class="badge inaccuracy">?!</span>
                                {:else if pair.black.classification === 'brilliant'}<span class="badge brilliant">!!</span>
                                {:else if pair.black.classification === 'best'}<span class="badge best">★</span>
                                {:else if pair.black.classification === 'good'}<span class="badge good">✓</span>{/if}
                            </button>
                        {/if}
                    </div>
                {/each}
            </div>
        </div>
    </aside>
</main>

<style>
    :global(body) { 
        margin: 0;
        background-color: #0f1115; 
        color: #e2e8f0; 
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    
    .dashboard { display: flex; gap: 24px; padding: 30px; max-width: 1350px; margin: 0 auto; min-height: 100vh; box-sizing: border-box; }
    .sidebar { width: 320px; background: #181a20; border-radius: 12px; display: flex; flex-direction: column; border: 1px solid #2b2f36; overflow: hidden; }
    .sidebar-header { padding: 20px; border-bottom: 1px solid #2b2f36; }
    .sidebar-header h2 { margin: 0 0 15px 0; font-size: 1.1rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;}
    .search-form { display: flex; border-radius: 6px; overflow: hidden; border: 1px solid #334155; }
    .search-form input { flex-grow: 1; padding: 10px 12px; background: #0f1115; border: none; color: white; outline: none; font-size: 0.95rem; }
    .search-form button { background: #3b82f6; color: white; border: none; padding: 0 16px; cursor: pointer; font-weight: 600; transition: background 0.2s;}
    .search-form button:hover { background: #2563eb; }
    .game-list { overflow-y: auto; flex-grow: 1; max-height: calc(100vh - 150px); }
    .game-list::-webkit-scrollbar { width: 6px; }
    .game-list::-webkit-scrollbar-track { background: transparent; }
    .game-list::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
    .game-btn { width: 100%; text-align: left; padding: 16px 20px; cursor: pointer; background: transparent; border: none; border-bottom: 1px solid #2b2f36; color: #e2e8f0; transition: background 0.2s ease; }
    .game-btn:hover { background: #1e232b; }
    .active-game { background: #1e293b; border-left: 3px solid #3b82f6; }
    .game-date { font-size: 0.75rem; color: #64748b; margin-bottom: 8px; text-align: right; }
    .players { display: flex; flex-direction: column; gap: 8px; }
    .player-row { display: flex; align-items: center; gap: 10px; font-size: 0.95rem; }
    .username { font-weight: 500; }
    .rating { color: #64748b; font-size: 0.8rem; }
    .main-stage { flex-grow: 1; display: flex; flex-direction: column; gap: 12px; align-items: center; max-width: 550px;}
    .player-nameplate { width: 100%; display: flex; align-items: center; gap: 12px; font-size: 1.1rem; padding: 0 5px; height: 32px; }
    .placeholder-text { color: #64748b; font-style: italic; font-size: 0.95rem;}
    .board-layout { display: flex; border-radius: 4px; overflow: hidden; box-shadow: 0 12px 30px rgba(0,0,0,0.6); }
    .eval-bar { width: 24px; height: 512px; background: #181a20; position: relative; display: flex; flex-direction: column-reverse; border-right: 1px solid #000; }
    .eval-fill { width: 100%; background: #f1f5f9; transition: height 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
    .eval-score-pill { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); font-family: monospace; font-size: 0.75rem; font-weight: 700; color: #64748b; background: rgba(15, 17, 21, 0.8); padding: 2px 4px; border-radius: 4px; z-index: 10; }
    .board-wrapper { width: 512px; height: 512px; }
    .analysis-hub { 
        width: 340px; 
        display: flex; 
        flex-direction: column; 
        gap: 20px; 
        /* Add these bounds to force scrolling */
        height: calc(100vh - 60px); 
        position: sticky; 
        top: 30px; 
    }
    .coach-card { background: #181a20; padding: 20px; border-radius: 12px; border: 1px solid #2b2f36; border-top: 4px solid #3b82f6; }
    .coach-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
    .coach-header h3 { margin: 0; display: flex; align-items: center; gap: 8px; color: #e2e8f0; font-size: 1.05rem; }
    .coach-btn { background: #3b82f6; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.85rem; transition: background 0.2s;}
    .coach-btn:hover:not(:disabled) { background: #2563eb; }
    .coach-btn:disabled { background: #334155; color: #94a3b8; cursor: not-allowed; }
    
    .move-status-text { font-weight: 800; font-size: 1.1rem; margin-bottom: 8px; text-transform: capitalize; }
    .coach-text { color: #94a3b8; line-height: 1.6; margin: 0; font-size: 0.95rem;}
    .notation-panel { 
            background: #181a20; 
            border-radius: 12px; 
            border: 1px solid #2b2f36; 
            display: flex; 
            flex-direction: column; 
            flex-grow: 1; 
            overflow: hidden; 
            /* Add this to let flexbox calculate the internal scroll height */
            min-height: 0; 
    }    
    .controls { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #2b2f36; background: #13151a;}
    .move-counter { font-weight: 600; color: #94a3b8; font-size: 0.95rem;}
    .nav-btn { background: #334155; color: #f8fafc; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; transition: background 0.2s; }
    .nav-btn:hover { background: #475569; }
    .analysis-progress { padding: 12px 20px; background: #13151a; border-bottom: 1px solid #2b2f36; }
    .progress-text { font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;}
    .progress-bar { height: 4px; background: #334155; border-radius: 2px; overflow: hidden; }
    .progress-fill { height: 100%; background: #3b82f6; transition: width 0.2s linear; }
    .analysis-complete { font-size: 0.8rem; color: #10b981; text-align: center; padding: 12px; background: rgba(16, 185, 129, 0.1); border-bottom: 1px solid #2b2f36; font-weight: 600; }
    .moves-grid { flex-grow: 1; overflow-y: auto; padding: 10px 15px; }
    .moves-grid::-webkit-scrollbar { width: 6px; }
    .moves-grid::-webkit-scrollbar-track { background: transparent; }
    .moves-grid::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
    .move-row { display: flex; align-items: center; padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.02); }
    .move-num { width: 35px; color: #64748b; font-size: 0.9rem; text-align: left; }
    .move-btn { flex: 1; background: transparent; border: none; color: #cbd5e1; text-align: left; padding: 8px 10px; cursor: pointer; font-weight: 500; font-size: 0.95rem; border-radius: 4px; display: flex; align-items: center; gap: 8px; transition: background 0.2s; }
    .move-btn:hover { background: #1e293b; color: #fff; }
    .move-btn.active { background: #3b82f6; color: #fff; }

    /* REDUCED DYNAMIC COLORS */
    .brilliant { color: #2dd4bf; } .badge.brilliant { background: #2dd4bf; font-size: 0.7rem; color: #000;} 
    .best { color: #22c55e; }      .badge.best { background: #22c55e; font-size: 0.9rem; color: #000;} 
    .good { color: #94a3b8; }      .badge.good { background: #94a3b8; color: #000;} 
    .inaccuracy { color: #facc15; } .badge.inaccuracy { background: #facc15; color: #000; font-size: 0.65rem;} 
    .mistake { color: #fb923c; }   .badge.mistake { background: #fb923c; color: #000;} 
    .blunder { color: #ef4444; }   .badge.blunder { background: #ef4444; font-size: 0.7rem; color: #000;} 

    .main-stage { 
        flex-grow: 1; 
        display: flex; 
        flex-direction: column; 
        gap: 12px; 
        align-items: center; 
        /* Slightly wider to accommodate the gap */
        max-width: 560px; 
    }

    .board-layout { 
        display: flex; 
        /* This separates the eval bar from the board */
        gap: 16px; 
    }

    .eval-bar { 
        width: 30px; /* Made slightly wider */
        height: 512px; 
        background: #181a20; 
        position: relative; 
        display: flex; 
        flex-direction: column-reverse; 
        border-radius: 6px;
        overflow: hidden;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }

    .board-wrapper { 
        width: 512px; 
        height: 512px; 
        border-radius: 6px;
        overflow: hidden;
        box-shadow: 0 12px 30px rgba(0,0,0,0.6);
    }

    .graph-container {
        width: 100%;
        height: 80px; /* Increased from 50px */
        margin-top: 4px;
        border-radius: 6px;
        overflow: hidden;
        background: #181a20;
        border: 1px solid #2b2f36;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    
    .graph-btn {
        width: 100%;
        height: 100%;
        padding: 0;
        margin: 0;
        border: none;
        background: transparent;
        cursor: pointer;
        display: block;
    }
    
    .eval-svg {
        width: 100%;
        height: 100%;
        display: block;
    }
    
    .san-text { 
        white-space: nowrap; 
        overflow: hidden; 
        text-overflow: ellipsis; 
        flex: 1 1 auto; /* Allows it to grow and shrink dynamically */
    }

    .eval-text { 
        font-family: monospace; 
        font-size: 0.8rem; 
        color: #64748b; 
        font-weight: 600; 
        flex: 0 0 auto; /* Completely refuses to shrink or grow */
    }
    
    .move-btn.active .eval-text { 
        color: #93c5fd; 
    }

    .badge { 
        width: 22px !important; 
        height: 22px !important; 
        flex: 0 0 22px !important; /* CRITICAL: Absolutely refuses to squish */
        box-sizing: border-box;
        display: inline-flex; 
        align-items: center; 
        justify-content: center; 
        border-radius: 50%; 
        font-weight: 800; 
        line-height: 1; 
        margin-left: 4px;
    }

    
</style>
// src/routes/+page.server.ts
export async function load({ fetch, url }) {
    // 1. Grab the username from the URL search parameters, or default to hikaru
    const username = url.searchParams.get('username') || 'hikaru'; 

    const headers = { 'User-Agent': 'ChessAnalyzer-LocalProject (treteggyt@gmail.com)' };

    try {
        const archivesRes = await fetch(`https://api.chess.com/pub/player/${username}/games/archives`, { headers });
        
        if (!archivesRes.ok) throw new Error("Player not found");
        
        const archivesData = await archivesRes.json();
        const archivesList = archivesData.archives;
        
        if (!archivesList || archivesList.length === 0) {
            return { games: [], currentUsername: username };
        }
        
        const latestMonthUrl = archivesList[archivesList.length - 1];
        const gamesRes = await fetch(latestMonthUrl, { headers });
        const gamesData = await gamesRes.json();

        // 2. Reverse the array so the newest games are at the top, and grab the last 15
        const recentGames = gamesData.games.reverse().slice(0, 15);

        return {
            games: recentGames,
            currentUsername: username // Send this back so the input box knows who we searched for
        };

    } catch (error) {
        console.error("Error fetching chess data:", error);
        return { games: [], currentUsername: username };
    }
}
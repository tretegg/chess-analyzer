import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';

// Initialize the Gemini SDK with your key from the .env file
const genAI = new GoogleGenerativeAI(env.VITE_GEMINI_API_KEY || "");

export async function POST({ request }) {
    try {
        const { fen, move, evalChange, bestMove } = await request.json();

        // The prompt is the most important part! 
        // We give Gemini the "Truth" (Stockfish data) so it doesn't hallucinate.
        const prompt = `
            You are a world-class chess coach. 
            Current board position (FEN): ${fen}
            The player just moved: ${move}
            The engine evaluation changed by: ${evalChange} pawns.
            The engine's recommended best move was: ${bestMove}

            Explain why the player's move was a mistake or why the engine's move is better. 
            Keep it under 3 sentences. Talk like a supportive coach. 
            If the move was actually good (evalChange is small), just explain the strategic intent.
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(prompt);
        const explanation = result.response.text();

        return json({ explanation });
    } catch (error) {
        console.error("Gemini Error:", error);
        return json({ explanation: "My coaching brain is a bit foggy right now. Try again in a second!" }, { status: 500 });
    }
}